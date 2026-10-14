// The production engine: runs ONE workflow on the real executor, journal, Zoanthrope and models.
//   decompose (Nemotron, seeing goals/non-goals/conditions and the agent catalog)
//   → baseline snapshot → mission (conditions are the acceptance decision) → DONE / FAILED / CANCELLED
// Everything it decides is a ledger event; it never reports DONE itself — the conditions do.

import { CliOneShotRunner, NativeLoopRunner } from "../agents/adapters.ts";
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
      const registry = new AgentRunnerRegistry([new NativeLoopRunner(model, undefined, research), new CliOneShotRunner()]);
      const missionMs = c.limits?.missionMs ?? (w0.budget?.minutes ? w0.budget.minutes * 60_000 : 15 * 60_000);
      const deadline = Date.now() + missionMs;
      const validation = new LocalRunner({ journal, runId, workspaceRoot: c.workspaceRoot, commands: c.commands, generation: lock.generation });

      const mission = await runMission(
        {
          executor, journal, model, budget, validation, signal: r.signal,
          ...(research ? { research } : {}),
          collector: new ZooCollector({ source: zoo, journal, runId }), collectEveryMs: 500, intent: zooIntentSink(zoo),
          ...(c.delegation ? { delegation: c.delegation } : {}),
          conditions: async (taskId) => {
            r.mark("VERIFYING");
            const w = r.workflow(); // re-read: the operator may have edited the conditions meanwhile (C2)
            const res = await evaluateWorkflow(w, {
              journal, runId, workspaceRoot: c.workspaceRoot, validation, taskId, baseline,
              awaitApproval: approvalWaiter(journal, runId, { pollMs: c.pollMs ?? 250, deadlineMs: deadline, aborted: () => r.signal.aborted }),
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
