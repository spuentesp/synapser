// The production engine: runs ONE workflow on the real executor, journal, Zoanthrope and models.
//   decompose (Nemotron, seeing goals/non-goals/conditions and the agent catalog)
//   → baseline snapshot → mission (conditions are the acceptance decision) → DONE / FAILED / CANCELLED
// Everything it decides is a ledger event; it never reports DONE itself — the conditions do.

import { CliOneShotRunner, NativeLoopRunner, nativeRoleUsesSystemModel } from "../agents/adapters.ts";
import { CLAUDE_CODE_ADAPTER } from "../agents/claude-code.ts";
import { CODEX_ADAPTER } from "../agents/codex.ts";
import { KIMI_ADAPTER } from "../agents/kimi.ts";
import { MIMO_ADAPTER } from "../agents/mimo.ts";
import { selectAuthorizedSkills } from "../agents/skills.ts";
import { GENERIC_CLI_ADAPTER } from "../agents/generic-cli.ts";
import { AgentRunnerRegistry } from "../agents/port.ts";
import type { AgentProfile } from "../agents/profile.ts";
import { Executor } from "../executor/executor.ts";
import { acquireWorkspaceLockInOrder } from "../journal/lock.ts";
import type { Journal } from "../journal/journal.ts";
import { runMission } from "../mission/runner.ts";
import type { Plan } from "../mission/plan.ts";
import { conditionCoverage, planMission } from "../mission/supervisor.ts";
import { BudgetManager } from "../model/budget.ts";
import type { ModelPort, Role as ModelRole } from "../model/types.ts";
import { buildCatalog, samplesFromJournal, type ProfileCard } from "../orchestration/catalog.ts";
import { LibraryRunError, type LibraryView, runLibrary } from "../library/resolve.ts";
import { reviewProfilesOf } from "./model.ts";
import type { DelegationConfig } from "../orchestration/delegation.ts";
import type { ResearchSession } from "../research/session.ts";
import { LocalRunner, type AllowedCommand } from "../validation/runner.ts";
import { listTree, treeDigest } from "../validation/snapshot.ts";
import { ZooAdapter } from "../zoo/adapter.ts";
import { ZooCollector } from "../zoo/collector.ts";
import { zooIntentSink } from "../zoo/intent.ts";
import { loadPin } from "../zoo/pin.ts";
import { Advisor } from "../advisor/advisor.ts";
import { PoolLimiter, type PoolSpec } from "../orchestration/pools.ts";
import { defaultModelConfig, modelConfigForProvider, type ProviderConfig } from "../model/config.ts";
import { journalRecorder, priceResolverForProviders } from "../model/recorder.ts";
import { libraryFetch } from "../model/destinations.ts";
import { OpenAICompatibleProvider } from "../model/openai-compatible-provider.ts";
import { DelegationBroker } from "../orchestration/delegation.ts";
import { approvalWaiter, baselineOf, evaluateWorkflow } from "./checkers.ts";
import type { EngineResult, EngineRun, WorkflowEngine } from "./manager.ts";
import type { Workflow } from "./model.ts";

export interface EngineConfig {
  workspaceRoot: string;
  stateDir: string;
  commands: AllowedCommand[];
  profiles: AgentProfile[];
  /** Provider definitions referenced by native agent profiles. */
  providers?: Record<string, ProviderConfig>;
  /** Key variable names library providers may use (plan 15 IC2), from the operator's file. Empty by default. */
  providerKeyEnv?: readonly string[];
  /** The library skills each agent id receives, decided by the operator's file (plan 14 Q5.4, decision D6). */
  agentSkills?: Record<string, readonly string[]>;
  /** One model port per run (so calls are recorded in THAT run's journal). */
  models: (journal: Journal) => ModelPort;
  research?: (journal: Journal, runId: string) => ResearchSession | undefined;
  knownUsdPerRun?: Record<string, number>;
  /** History of earlier runs used to learn per-profile cost (plan 10 §2.1). */
  history?: (journal: Journal) => ReturnType<typeof samplesFromJournal>;
  /** Replace the decomposition (tests). Receives the workflow and the catalog. */
  planner?: (w: Workflow, catalog: ProfileCard[], journal: Journal) => Promise<Plan>;
  limits?: { concurrency?: number; maxRepairRounds?: number; maxTaskAttempts?: number; missionMs?: number; maxTokens?: number };
  delegation?: Partial<DelegationConfig>;
  /** Concurrency limits per pool of agents. */
  pools?: PoolSpec[];
  /** The advisor (plan 13 §6). Off when `enabled` is false. `pushback`: critique tasks with Tavily before dispatch. */
  advisor?: { enabled: boolean; pushback?: "off" | "writes"; maxConsults?: number; maxPerTask?: number };
  /** Poll period while waiting for a human on an approval condition / gate. */
  pollMs?: number;
}

export class ProductionEngine implements WorkflowEngine {
  readonly #c: EngineConfig;
  constructor(c: EngineConfig) {
    this.#c = c;
  }

  async run(r: EngineRun): Promise<EngineResult> {
    const c = this.#c;
    // plan 14 Q5.1: the library this run reads is its snapshot, checked under the operator's file. A run whose library
    // does not hold stops here, before it takes the workspace lock.
    let library: LibraryView;
    try {
      library = runLibrary({ providers: c.providers ?? defaultModelConfig().providers, profiles: c.profiles, ...(c.providerKeyEnv ? { providerKeyEnv: c.providerKeyEnv } : {}), ...(c.agentSkills ? { agentSkills: c.agentSkills } : {}) }, r.library);
    } catch (e) {
      if (e instanceof LibraryRunError) return { status: "FAILED", reason: e.message };
      throw e;
    }
    // plan 14 Q5.2: a review that names an agent this run's library does not hold cannot be judged; the run stops here
    const missing = reviewProfilesOf(r.workflow()).filter((id) => !library.profiles.some((p) => p.id === id));
    if (missing.length) return { status: "FAILED", reason: `this run's library does not hold the agents its reviews name: ${missing.join(", ")}` };
    const { journal, runId } = r;
    // A second run in the same workspace waits its turn (first come, first served, plan 18 E10) instead of failing at once.
    const lock = await acquireWorkspaceLockInOrder(c.stateDir, c.workspaceRoot);
    const zoo = await ZooAdapter.open(loadPin(), c.workspaceRoot);
    try {
      const executor = new Executor({ workspace: c.workspaceRoot, runId, journal, zoo, generation: lock.generation });
      const model = c.models(journal);
      const budget = new BudgetManager({ maxTokens: c.limits?.maxTokens ?? 800_000, maxCalls: 200 });
      const research = c.research?.(journal, runId);
      const catalog = buildCatalog(library.profiles, c.history?.(journal) ?? [], { ...(c.knownUsdPerRun ? { knownUsdPerRun: c.knownUsdPerRun } : {}), allowedSkillsByProfile: new Map([...library.skillsFor].map(([id, skills]) => [id, skills.map((skill) => skill.id)])) });
      const w0 = r.workflow();

      // ---- decompose -------------------------------------------------------------------------
      const plan: Plan = c.planner
        ? await c.planner(w0, catalog, journal)
        : (await planMission(model, { runId, objective: w0.description, contract: w0.goals, workspaceRoot: c.workspaceRoot, maxTasks: 8, catalog, workflow: w0 }, { budget })).plan;
      journal.tx((t) => t.event(runId, "decomposition", runId, null, "ACCEPTED", { tasks: plan.tasks.length, serves: plan.tasks.map((x) => ({ id: x.id, serves: x.serves ?? [] })), uncovered: [...conditionCoverage(w0).mustServe].filter((id) => !plan.tasks.some((x) => x.serves?.includes(id))) }));
      if (r.signal.aborted) return { status: "CANCELLED", reason: "cancelled while planning" };

      // ---- baseline: what the repository looked like BEFORE any agent touched it ------------------
      const baseline = baselineOf(c.workspaceRoot);
      journal.tx((t) => t.event(runId, "baseline", runId, null, "TAKEN", { files: baseline.size }));
      r.mark("RUNNING");

      const profileIds = new Set(library.profiles.map((p) => p.id));
      // A native agent can bring its own brain. Provider data is shared and credentials remain env names.
      const providers = library.providers;
      const own = new Map<string, ModelPort>();
      const modelFor = (p: AgentProfile, role: ModelRole): ModelPort | null => {
        // L6/Q2.3: worker and repair assignments govern native agents too. Keep their profile provider
        // metadata validated, but route inference through the shared role-aware ModelPort.
        if (nativeRoleUsesSystemModel(role) && p.role !== "advisor") return null;
        if (!p.provider) return null;
        let m = own.get(p.id);
        if (!m) {
          const provider = providers[p.provider];
          if (!provider) throw new Error(`native agent ${p.id} references unknown provider ${p.provider}`);
          if (provider.protocol !== "openai-compatible") throw new Error(`native agent ${p.id} needs an openai-compatible provider; ${p.provider} speaks ${provider.protocol}`);
          if (!p.model || !provider.models.some((item) => item.id === p.model)) {
            throw new Error(`native agent ${p.id} references undeclared model ${p.model ?? "(missing)"} on provider ${p.provider}`);
          }
          m = new OpenAICompatibleProvider({
            config: modelConfigForProvider(p.provider, provider, p.model, p.temperature ?? 0),
            // Bind accounting to the selected provider. Two providers may legally share URL/model.
            // plan 15 D4: tariffs come only from the operator's file. A library provider's prices are never summed into a cost
            // plan 15 D3: a library provider's calls go through the guarded fetch; the operator's own providers do not
            fetch: Object.hasOwn(c.providers ?? defaultModelConfig().providers, p.provider) ? undefined : libraryFetch(),
            onCall: journalRecorder(journal, priceResolverForProviders({ [p.provider]: Object.hasOwn(c.providers ?? defaultModelConfig().providers, p.provider) ? provider : { ...provider, models: provider.models.map((m) => ({ id: m.id })) } })),
          });
          own.set(p.id, m);
        }
        return m;
      };
      // plan 17 P17.6: CLI runners resolve an injectProvider against the operator's providers, never the library's.
      const operatorProviders = () => c.providers ?? defaultModelConfig().providers;
      const registry = new AgentRunnerRegistry([new NativeLoopRunner(model, undefined, research, modelFor), new CliOneShotRunner(undefined, operatorProviders), new CliOneShotRunner(GENERIC_CLI_ADAPTER, operatorProviders), new CliOneShotRunner(CLAUDE_CODE_ADAPTER, operatorProviders), new CliOneShotRunner(CODEX_ADAPTER, operatorProviders), new CliOneShotRunner(KIMI_ADAPTER, operatorProviders), new CliOneShotRunner(MIMO_ADAPTER, operatorProviders)], { skillsFor: (profileId, selection) => selectAuthorizedSkills(library.skillsFor.get(profileId) ?? [], selection) });
      const pools = c.pools?.length ? new PoolLimiter(c.pools) : undefined;
      const missionMs = c.limits?.missionMs ?? (w0.budget?.minutes ? w0.budget.minutes * 60_000 : 15 * 60_000);
      const deadline = Date.now() + missionMs;
      const validation = new LocalRunner({ journal, runId, workspaceRoot: c.workspaceRoot, commands: c.commands, generation: lock.generation });

      // ---- the advisor: Nemotron proposes, control validates (plan 13 §6) --------------------------
      const advisorOn = c.advisor?.enabled !== false && c.advisor !== undefined;
      const broker = new DelegationBroker({ journal, runId, workspaceRoot: c.workspaceRoot, config: c.delegation ?? {} });
      const advisor = advisorOn
        ? new Advisor({
            journal, runId, model, budget, workflow: r.workflow, delegation: broker, executor, workspaceRoot: c.workspaceRoot,
            ...(research ? { research } : {}),
            limits: { ...(c.advisor?.maxConsults ? { maxConsults: c.advisor.maxConsults } : {}), ...(c.advisor?.maxPerTask ? { maxPerTask: c.advisor.maxPerTask } : {}) },
          })
        : null;
      const advisorTick = advisor ? setInterval(() => void advisor.tick().catch(() => {}), c.pollMs ?? 250) : null;
      const pushbackOn = advisor !== null && c.advisor?.pushback === "writes" && research !== undefined;

      let mission;
      try {
      mission = await runMission(
        {
          executor, journal, model, budget, validation, signal: r.signal,
          ...(advisor
            ? {
                advisor: {
                  notes: (t: string) => advisor.notes(t),
                  held: (t: string) => advisor.held(t),
                  escalations: (t: string) => advisor.escalations(t),
                  pushbackState: (t: string) => advisor.pushbackState(t),
                  superseded: (t: string) => advisor.superseded(t),
                  consult: (tr: Parameters<Advisor["consult"]>[0]) => advisor.consult(tr),
                  ...(pushbackOn
                    ? {
                        preflight: async (t: string) => {
                          const row = journal.listTasks().find((x) => x.taskId === t);
                          if (!row || (row.spec?.step ?? "write") !== "write" || row.spec?.kind === "repair") return false;
                          const findings = await advisor.critique(t);
                          const serious = findings.filter((f) => f.severity !== "low");
                          if (serious.length === 0) return false;
                          return (await advisor.pushback(t, serious, "the advisor found problems with this task's assumptions before it started")) !== null;
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(research ? { research } : {}),
          collector: new ZooCollector({ source: zoo, journal, runId }), collectEveryMs: 500, intent: zooIntentSink(zoo),
          ...(c.delegation ? { delegation: c.delegation } : {}),
          effects: r.effects,
          conditions: async (taskId) => {
            r.mark("VERIFYING");
            const w = r.workflow(); // re-read: the operator may have edited the conditions meanwhile (C2)
            const res = await evaluateWorkflow(w, {
              journal, runId, workspaceRoot: c.workspaceRoot, validation, taskId, baseline,
              awaitApproval: approvalWaiter(journal, runId, { pollMs: c.pollMs ?? 250, deadlineMs: deadline, aborted: () => r.signal.aborted }),
              ensureEffect: async (kind, params) => {
                const matches = (rec: { kind: string; params: Record<string, unknown> }) =>
                  rec.kind === kind && Object.entries(params).every(([k, v]) => JSON.stringify(rec.params[k]) === JSON.stringify(v));
                let rec = r.effects.records().filter(matches).at(-1) ?? null;
                if (!rec || ["DENIED", "REJECTED", "FAILED", "STALE", "EXPIRED"].includes(rec.state)) {
                  // a terminal failure of an EARLIER request is not the answer for the current tree: ask again
                  if (rec && rec.state !== "STALE" && rec.state !== "EXPIRED" && rec.state !== "FAILED") return { state: rec.state, reason: rec.reason, evidence: rec.evidence, summary: rec.summary };
                  const q = await r.effects.request({ kind, params, requestedBy: `workflow:${w.id}` });
                  if (!q.ok) return { state: "INVALID", reason: (q.errors ?? [q.code]).join("; "), evidence: null, summary: "" };
                  rec = r.effects.status(q.id);
                }
                const until = Date.now() + Math.max(1000, deadline - Date.now());
                while (rec && (rec.state === "PENDING" || rec.state === "EXECUTING") && !r.signal.aborted && Date.now() < until) {
                  await new Promise((res) => setTimeout(res, c.pollMs ?? 250));
                  rec = r.effects.status(rec.id);
                }
                return rec ? { state: rec.state, reason: rec.reason, evidence: rec.evidence, summary: rec.summary } : { state: "UNKNOWN", reason: null, evidence: null, summary: "" };
              },
              review: async (profileId, rubric, expectedSnapshot) => {
                const profile = library.profiles.find((p) => p.id === profileId);
                if (!profile || !profileIds.has(profileId)) return { verdict: "fail", text: `unknown reviewer ${profileId}` };
                if (profile.role !== "advisor") return { verdict: "fail", text: `reviewer ${profileId} must have advisor role` };
                if (journal.listAgentRuns().some((run) => run.profileId === profileId && run.role !== "advisor")) {
                  return { verdict: "fail", text: `reviewer ${profileId} already wrote in this run and cannot review its own work` };
                }
                if (treeDigest(c.workspaceRoot) !== expectedSnapshot) return { verdict: "fail", text: "review snapshot changed before reviewer launch" };
                const reviewScope = listTree(c.workspaceRoot);
                const run = await registry.for(profile).run({
                  profile, workspaceRoot: c.workspaceRoot, runId, journal, executor, generation: lock.generation, ...(budget ? { budget } : {}),
                  task: {
                    taskId: `review-${Date.now().toString(36)}`, objective: `Inspect the exact read-only repository snapshot ${expectedSnapshot}. Do not modify files or use effects. End your answer with exactly "VERDICT: PASS" or "VERDICT: FAIL".\nRUBRIC: ${rubric}`,
                    scope: reviewScope, criteria: [rubric], planRevision: 1,
                  },
                });
                const isolatedResult = run.integration.mode === "pending" ? run.integration.run : null;
                const runRow = journal.listAgentRuns().find((row) => row.agentRunId === run.agentRunId);
                const reviewerBaseDigest = isolatedResult?.baseDigest ?? runRow?.baseDigest;
                const reviewerBaseConsistent = isolatedResult?.baseConsistent ?? reviewerBaseDigest === expectedSnapshot;
                const reviewerChanges = isolatedResult?.changes ?? run.changedPaths;
                if (!reviewerBaseConsistent || reviewerBaseDigest !== expectedSnapshot) {
                  return { verdict: "fail", text: "reviewer snapshot was inconsistent with the condition-round digest" };
                }
                if (reviewerChanges.length > 0) return { verdict: "fail", text: "reviewer attempted to change its isolated snapshot; result rejected" };
                if (treeDigest(c.workspaceRoot) !== expectedSnapshot) return { verdict: "fail", text: "live workspace changed during review; result rejected as stale" };
                if (run.outcome !== "SUCCEEDED") return { verdict: "fail", text: `reviewer did not complete successfully (${run.outcome})` };
                const text = run.finalText ?? "";
                return { verdict: /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text) ? "pass" : "fail", text };
              },
            });
            if (!res.satisfied) r.mark("RUNNING");
            return { ...res, meta: { doc_revision: r.revision(), workflow: w.id } };
          },
          orchestration: {
            catalog, profiles: library.profiles, registry, executor, workspaceRoot: c.workspaceRoot, generation: lock.generation,
            approval: { pollMs: c.pollMs ?? 250 },
            effects: r.effects,
            ...(pools ? { pools } : {}),
          },
        },
        {
          runId, objective: w0.description, plan, acceptance: [],
          limits: {
            concurrency: c.limits?.concurrency ?? 3, maxRepairRounds: c.limits?.maxRepairRounds ?? 2, missionMs,
            ...(c.limits?.maxTaskAttempts ? { maxTaskAttempts: c.limits.maxTaskAttempts } : {}),
          },
        },
      );
      } finally {
        if (advisorTick) clearInterval(advisorTick);
      }
      return {
        status: mission.status === "DONE" ? "DONE" : mission.status === "CANCELLED" ? "CANCELLED" : mission.status === "TIMED_OUT" ? "TIMED_OUT" : "FAILED",
        reason: mission.reason,
      };
    } finally {
      await zoo.close();
      lock.release();
    }
  }
}
