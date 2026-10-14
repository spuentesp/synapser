// Executes ONE plan step through the router and the AgentRunner port (plan 10 §3–§4):
//   route → record the dispatch (what, why, under which plan) → run → land the work.
// A non-write step runs with an empty write scope and its result is NEVER integrated.

import type { AgentProfile } from "../agents/profile.ts";
import { type AgentRunnerRegistry, runAndIntegrate } from "../agents/port.ts";
import type { Executor } from "../executor/executor.ts";
import type { Journal } from "../journal/journal.ts";
import type { BudgetManager } from "../model/budget.ts";
import type { ProfileCard, StepKind } from "./catalog.ts";
import type { DelegationPort } from "./delegation.ts";
import { recordDispatch } from "./invariants.ts";
import { route } from "./router.ts";

export interface ApprovalPolicy {
  /** Deterministic rule evaluated when a gate opens; `null` leaves it to a human. */
  auto?: (ctx: { taskId: string; objective: string }) => { approve: boolean; actor: string; reason?: string } | null;
  pollMs?: number;
}

export interface OrchestrationDeps {
  catalog: readonly ProfileCard[];
  profiles: readonly AgentProfile[];
  registry: AgentRunnerRegistry;
  /** Concrete executor: the patch broker needs blobs and views, not just the loop surface. */
  executor: Executor;
  workspaceRoot: string;
  generation: number;
  approval?: ApprovalPolicy;
}

export interface StepRow {
  taskId: string;
  scope: string[];
  spec: { objective: string; criteria: string[]; context?: string[]; step?: StepKind; profile?: string; tags?: string[]; gates?: string[]; kind?: string };
}

export interface StepOutcome {
  ok: boolean;
  label: string;
  detail?: string;
  /** The profile that ran (or was about to), so a retry can avoid it. */
  profileId?: string;
}

export async function dispatchStep(
  o: OrchestrationDeps,
  ctx: { journal: Journal; runId: string; planDigest: string; deadlineMs: number; budget?: BudgetManager },
  row: StepRow,
  delegation: DelegationPort | null = null,
  exclude: readonly string[] = [],
): Promise<StepOutcome> {
  const kind: StepKind = row.spec.step ?? "write";
  const isRepair = row.spec.kind === "repair";
  const tags = row.spec.tags ?? (isRepair ? ["repair"] : []);
  // a retry avoids the profile that just failed — unless nothing else can do the step
  const first = route({ kind, suggested: row.spec.profile, tags, exclude }, o.catalog);
  const d = !first.ok && exclude.length ? route({ kind, suggested: row.spec.profile, tags }, o.catalog) : first;
  if (!d.ok) return { ok: false, label: "NO_ROUTE", detail: d.rejected.map((r) => `${r.profileId}:${r.code}`).join(",") };
  const card = o.catalog.find((c) => c.id === d.profileId) as ProfileCard;
  const profile = o.profiles.find((p) => p.id === d.profileId) as AgentProfile;
  recordDispatch(ctx.journal, ctx.runId, {
    taskId: row.taskId,
    profileId: d.profileId,
    kind,
    reason: d.reason,
    suggested: row.spec.profile ?? null,
    costBasis: card.cost.basis,
    planDigest: ctx.planDigest,
    gates: row.spec.gates ?? [],
    alerts: d.alerts,
  });
  const req = {
    profile,
    task: {
      taskId: row.taskId,
      objective: row.spec.objective,
      // an advisory step may READ the files it was pointed at but is given no write scope
      scope: kind === "write" ? row.scope : [],
      criteria: row.spec.criteria,
      context: row.spec.context ?? [],
      planRevision: 1,
    },
    workspaceRoot: o.workspaceRoot,
    runId: ctx.runId,
    journal: ctx.journal,
    executor: o.executor,
    generation: o.generation,
    ...(ctx.budget ? { budget: ctx.budget } : {}),
    deadlineMs: ctx.deadlineMs,
    ...(delegation ? { delegation } : {}),
  };

  if (kind !== "write") {
    const run = await o.registry.for(profile).run(req);
    if (run.changedPaths.length > 0) return { ok: false, label: "ADVISOR_CHANGED_FILES", detail: run.changedPaths.join(","), profileId: d.profileId };
    return run.outcome === "SUCCEEDED"
      ? { ok: true, label: "FINISHED", profileId: d.profileId }
      : { ok: false, label: run.outcome, profileId: d.profileId, ...(run.reason ? { detail: run.reason } : {}) };
  }
  const res = await runAndIntegrate(o.registry, req);
  const landed = res.integration.status === "INTEGRATED" || res.integration.status === "DIRECT" || res.integration.status === "NO_CHANGES";
  if (res.run.outcome === "SUCCEEDED" && landed) return { ok: true, label: "FINISHED", profileId: d.profileId };
  return {
    ok: false,
    profileId: d.profileId,
    label: res.run.outcome !== "SUCCEEDED" ? res.run.outcome : res.integration.status,
    ...(res.integration.detail ?? res.run.reason ? { detail: String(res.integration.detail ?? res.run.reason) } : {}),
  };
}
