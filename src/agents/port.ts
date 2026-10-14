// AgentRunner: the common interface (design: "una interfaz común con implementaciones").
//
//   run(request) → AgentRunOutput        what happened, observed, in ONE shape for every adapter
//   runAndIntegrate(...)                 the workflow's single entry point: run, then land the work
//
// Implementations differ in HOW work is produced and landed:
//   native       in-process Nemotron loop; every write already went through the executor
//                (integration.mode = "direct")
//   cli-oneshot  a third-party CLI in an isolated copy; its change set must pass the patch broker
//                (integration.mode = "pending")
//   orca         (future) workers driven through Orca's orchestration; same contract
// The ledger row (`agent_runs`) is written by the implementation and has the same fields for all.

import type { Executor } from "../executor/executor.ts";
import type { Journal } from "../journal/journal.ts";
import type { BudgetManager } from "../model/budget.ts";
import { integrateRun, type IntegrationResult } from "./broker.ts";
import { type AdapterId, type AgentProfile, adapterOf } from "./profile.ts";
import type { AgentRunResult, FileChange } from "./runner.ts";
import type { Outcome, UsageRecord } from "./usage.ts";

export interface AgentTaskSpec {
  taskId: string;
  objective: string;
  scope: readonly string[];
  criteria: readonly string[];
  context?: readonly string[];
  planRevision: number;
}

export interface AgentRunRequest {
  profile: AgentProfile;
  task: AgentTaskSpec;
  /** Extra material appended to the task prompt by the workflow (e.g. a reviewer's findings). */
  extraPrompt?: string;
  workspaceRoot: string;
  runId: string;
  journal: Journal;
  executor: Executor;
  generation: number;
  budget?: BudgetManager;
  deadlineMs?: number;
  /** Native agents may ask for subtasks through this port; CLI agents have no such tool. */
  delegation?: import("../orchestration/delegation.ts").DelegationPort;
  /** Native agents may ASK for side effects here; CLI agents cannot (they have no channel back). */
  effects?: import("../effects/port.ts").EffectPort;
}

export type IntegrationMode =
  | { mode: "direct"; actions: { actionId: string; status: string; error: string | null }[] }
  | { mode: "pending"; run: AgentRunResult };

export interface AgentRunOutput {
  agentRunId: string;
  profileId: string;
  adapter: AdapterId;
  role: string;
  outcome: Outcome;
  reason: string | null;
  durationMs: number;
  usage: UsageRecord;
  toolUse: Record<string, number> | null;
  sessionId: string | null;
  finalText: string | null;
  /** The files this run changed (or, for direct mode, the files its applied actions changed). */
  changedPaths: string[];
  integration: IntegrationMode;
}

export interface AgentRunner {
  readonly adapter: AdapterId;
  run(req: AgentRunRequest): Promise<AgentRunOutput>;
}

export class AgentRunnerRegistry {
  readonly #by = new Map<AdapterId, AgentRunner>();
  constructor(runners: readonly AgentRunner[]) {
    for (const r of runners) {
      if (this.#by.has(r.adapter)) throw new Error(`duplicate runner for adapter ${r.adapter}`);
      this.#by.set(r.adapter, r);
    }
  }
  for(profile: AgentProfile): AgentRunner {
    const r = this.#by.get(adapterOf(profile));
    if (!r) throw new Error(`no runner registered for adapter "${adapterOf(profile)}" (profile ${profile.id})`);
    return r;
  }
  adapters(): AdapterId[] {
    return [...this.#by.keys()];
  }
}

export interface StepResult {
  run: AgentRunOutput;
  /** For pending mode: what the broker decided. For direct mode: derived from the applied actions. */
  integration: { status: IntegrationResult["status"] | "DIRECT"; detail: string | null; files: string[] };
}

/** Run one step of a workflow with any profile and land its work, whatever the adapter. */
export async function runAndIntegrate(registry: AgentRunnerRegistry, req: AgentRunRequest): Promise<StepResult> {
  const runner = registry.for(req.profile);
  const run = await runner.run(req);
  if (run.integration.mode === "direct") {
    const bad = run.integration.actions.filter((a) => a.status !== "SETTLED" && a.status !== "APPLIED");
    req.journal.tx((t) =>
      t.event(req.runId, "agent_run_integration", run.agentRunId, null, "DIRECT", { task_id: req.task.taskId, files: run.changedPaths, detail: bad.length ? `${bad.length} action(s) not applied` : null, action_id: null }),
    );
    return {
      run,
      integration: { status: "DIRECT", detail: bad.length ? `${bad.length} action(s) not applied` : null, files: run.changedPaths },
    };
  }
  const { incarnation } = req.executor.beginSession({ taskId: req.task.taskId, scope: req.task.scope, planRevision: req.task.planRevision });
  const r = await integrateRun(req.executor, { taskId: req.task.taskId, incarnation }, run.integration.run);
  req.journal.tx((t) =>
    t.event(req.runId, "agent_run_integration", run.agentRunId, null, r.status, { task_id: req.task.taskId, files: r.files, detail: r.detail, action_id: r.receipt?.action_id ?? null }),
  );
  return { run, integration: { status: r.status, detail: r.detail, files: r.files } };
}

export type { FileChange };
