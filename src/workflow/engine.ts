// The production engine: runs ONE workflow on the real executor, journal, Zoanthrope and models.
//   decompose (Nemotron, seeing goals/non-goals/conditions and the agent catalog)
//   → baseline snapshot → mission (conditions are the acceptance decision) → DONE / FAILED / CANCELLED
// Everything it decides is a ledger event; it never reports DONE itself — the conditions do.

import { CliOneShotRunner, NativeLoopRunner } from "../agents/adapters.ts";
import { CLAUDE_CODE_ADAPTER } from "../agents/claude-code.ts";
import { AgentRunnerRegistry } from "../agents/port.ts";
import type { AgentProfile } from "../agents/profile.ts";
import { Executor } from "../executor/executor.ts";
import { acquireWorkspaceLock } from "../journal/lock.ts";
import type { Journal } from "../journal/journal.ts";
import { runMission } from "../mission/runner.ts";
import type { Plan } from "../mission/plan.ts";
import { conditionCoverage, planMission } from "../mission/supervisor.ts";
import { BudgetManager } from "../model/budget.ts";
import type { ModelPort } from "../model/types.ts";
import { buildCatalog, samplesFromJournal, type ProfileCard } from "../orchestration/catalog.ts";
import type { DelegationConfig } from "../orchestration/delegation.ts";
import type { ResearchSession } from "../research/session.ts";
import { LocalRunner, type AllowedCommand } from "../validation/runner.ts";
import { ZooAdapter } from "../zoo/adapter.ts";
import { ZooCollector } from "../zoo/collector.ts";
import { zooIntentSink } from "../zoo/intent.ts";
import { loadPin } from "../zoo/pin.ts";
import { Advisor } from "../advisor/advisor.ts";
import { PoolLimiter, type PoolSpec } from "../orchestration/pools.ts";
import { modelConfigForEndpoint } from "../model/config.ts";
import { journalRecorder } from "../model/recorder.ts";
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
    const { journal, runId } = r;
    const lock = acquireWorkspaceLock(c.stateDir, c.workspaceRoot);
    const zoo = await ZooAdapter.open(loadPin(), c.workspaceRoot);
    try {
      const executor = new Executor({ workspace: c.workspaceRoot, runId, journal, zoo, generation: lock.generation });
      const model = c.models(journal);
      const budget = new BudgetManager({ maxTokens: c.limits?.maxTokens ?? 800_000, maxCalls: 200 });
      const research = c.research?.(journal, runId);
      const catalog = buildCatalog(c.profiles, c.history?.(journal) ?? [], { ...(c.knownUsdPerRun ? { knownUsdPerRun: c.knownUsdPerRun } : {}) });
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

      const profileIds = new Set(c.profiles.map((p) => p.id));
      // an `endpoint` agent brings its own brain (any OpenAI-compatible server); calls are recorded here
      const own = new Map<string, ModelPort>();
      const modelFor = (p: AgentProfile): ModelPort | null => {
        if (!p.endpoint) return null;
        let m = own.get(p.id);
        if (!m) {
          m = new OpenAICompatibleProvider({ config: modelConfigForEndpoint(p.endpoint), onCall: journalRecorder(journal) });
          own.set(p.id, m);
        }
        return m;
      };
      const registry = new AgentRunnerRegistry([new NativeLoopRunner(model, undefined, research, modelFor), new CliOneShotRunner(), new CliOneShotRunner(CLAUDE_CODE_ADAPTER)]);
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
              review: async (profileId, rubric) => {
                const profile = c.profiles.find((p) => p.id === profileId);
                if (!profile || !profileIds.has(profileId)) return { verdict: "fail", text: `unknown reviewer ${profileId}` };
                const run = await registry.for(profile).run({
                  profile, workspaceRoot: c.workspaceRoot, runId, journal, executor, generation: lock.generation, ...(budget ? { budget } : {}),
                  task: {
                    taskId: `review-${Date.now().toString(36)}`, objective: `Review the repository against this rubric and end your answer with exactly "VERDICT: PASS" or "VERDICT: FAIL".\nRUBRIC: ${rubric}`,
                    scope: [], criteria: [rubric], planRevision: 1,
                  },
                });
                const text = run.finalText ?? "";
                return { verdict: /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text) ? "pass" : "fail", text };
              },
            });
            if (!res.satisfied) r.mark("RUNNING");
            return { ...res, meta: { doc_revision: r.revision(), workflow: w.id } };
          },
          orchestration: {
            catalog, profiles: c.profiles, registry, executor, workspaceRoot: c.workspaceRoot, generation: lock.generation,
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
