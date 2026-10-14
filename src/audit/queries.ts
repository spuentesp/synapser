// Deterministic audit queries. Every answer is derived from recorded facts by joins on ids and
// ordering by sequence number — no model, no inference, stable output for the same ledger.
//
// What "why" means here: the DECLARED causal chain (mission → task → agent run → action → files →
// validation) plus what the agent itself wrote, labelled `asserted`. A model's private reasoning is
// not observable; this module never pretends otherwise.

import type { Journal } from "../journal/journal.ts";
import { type ChainVerdict, verifyChain } from "./chain.ts";

type Ev = ReturnType<Journal["listEvents"]>[number];

const INTEGRATED = new Set(["INTEGRATED", "DIRECT"]);
const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

// ---- integrity ----------------------------------------------------------------------------------

export function verify(journal: Journal, expectedHead?: string): ChainVerdict {
  return verifyChain(journal.runId, journal.eventChain(), expectedHead);
}

export function exportLedger(journal: Journal): { head: string; verified: ChainVerdict; events: ReturnType<Journal["eventChain"]> } {
  const events = journal.eventChain();
  const verified = verifyChain(journal.runId, events);
  return { head: verified.head, verified, events };
}

// ---- timeline -----------------------------------------------------------------------------------

export interface TimelineEntry {
  seq: number;
  ts: number;
  kind: string;
  id: string;
  from: string | null;
  to: string | null;
  summary: string;
}

const summarize = (e: Ev): string => {
  const d = (e.data ?? {}) as Record<string, any>;
  switch (e.entity) {
    case "agent_run":
      return `agent run ${e.entityId} (${d.profile}) ${e.toState}; in=${d.input_tokens ?? "?"} out=${d.output_tokens ?? "?"} usd=${d.cost_usd ?? "?"}${d.reason ? ` — ${d.reason}` : ""}`;
    case "agent_run_integration":
      return `integration of ${e.entityId}: ${e.toState}${d.detail ? ` (${d.detail})` : ""}${d.files?.length ? ` files=${d.files.join(",")}` : ""}`;
    case "action":
      return `action ${e.entityId} ${e.fromState ?? "∅"} → ${e.toState}${d.error_code ? ` [${d.error_code}]` : ""}${d.holder ? ` (waiting on ${d.holder})` : ""}`;
    case "task":
      return `task ${e.entityId} ${e.fromState ?? "∅"} → ${e.toState}`;
    case "mission":
      return `mission ${e.fromState ?? "∅"} → ${e.toState}`;
    case "validation":
      return `validation ${e.entityId} ${e.toState}`;
    case "model_call":
      return `model call ${e.entityId} ${d.role}/${d.served_model ?? d.requested_model} ${e.toState} tokens=${d.prompt_tokens ?? "?"}+${d.completion_tokens ?? "?"}`;
    case "dispatch":
      return `${e.entityId} routed to ${d.profile} (${d.kind}, ${d.reason}${d.suggested && d.suggested !== d.profile ? `, suggested ${d.suggested} overridden` : ""}; cost ${d.cost_basis})`;
    case "delegation":
      return e.toState === "ACCEPTED"
        ? `${d.requester} requested subtask ${e.entityId} (depth ${d.depth}, scope ${(d.scope ?? []).join(",")})`
        : `${d.requester} subtask request REFUSED: ${d.code}${d.detail ? ` — ${d.detail}` : ""}`;
    case "approval":
      return `approval for ${e.entityId}: ${e.toState}${d.actor ? ` by ${d.actor}` : ""}${d.reason ? ` (${d.reason})` : ""}`;
    case "alert":
      return `alert ${e.toState} on ${e.entityId}${d.profile ? ` (${d.profile})` : ""}`;
    case "intent":
      return `intention of ${e.entityId} ${e.toState === "POSTED" ? "announced to Zoanthrope" : `could not be announced: ${d.error}`}`;
    case "zoo_observation":
      return `zoanthrope: ${d.agent} ${d.action}${d.path ? ` ${d.path}` : ""}${d.purpose ? ` — ${d.purpose}` : ""}`;
    case "zoo_gap":
      return e.toState === "GAP" ? `zoanthrope audit ring wrapped: events between ts ${d.since_ts} and ${d.oldest_ts} may be unaccounted for` : `zoanthrope observation ${e.toState}${d.error ? `: ${d.error}` : ""}`;
    case "research_call":
      return `search ${e.toState}${d.query ? `: "${String(d.query).slice(0, 80)}"` : " (refused)"} → ${(d.urls ?? []).length} source(s)${d.cached ? " [cached]" : ""}${d.error ? ` — ${d.error}` : ""}`;
    case "acceptance_check":
      return `check ${d.check}: ${e.toState} — ${d.detail}`;
    case "task_retry":
      return `${e.entityId} retried (${e.toState?.toLowerCase().replace("_", " ")}) after ${d.after}${(d.avoided ?? []).length ? `, avoiding ${(d.avoided as string[]).join(",")}` : ""}`;
    case "task_dep":
      return `${e.entityId} now also waits for ${d.depends_on}`;
    case "agent_step":
      return `step ${d.step} of ${e.entityId}: ${d.tool ?? "—"} ${e.toState}${d.detail ? ` (${d.detail})` : ""}`;
    default:
      return `${e.entity} ${e.entityId} ${e.fromState ?? "∅"} → ${e.toState ?? "∅"}`;
  }
};

export function timeline(journal: Journal, filter: { taskId?: string; entity?: string; sinceSeq?: number } = {}): TimelineEntry[] {
  const agentRunTask = new Map(journal.listAgentRuns().map((r) => [r.agentRunId, r.taskId]));
  const actionTask = new Map(journal.listAllActions().map((a) => [a.actionId, a.taskId]));
  return journal
    .listEvents(filter.sinceSeq ?? 0)
    .filter((e) => {
      if (filter.entity && e.entity !== filter.entity) return false;
      if (!filter.taskId) return true;
      const d = (e.data ?? {}) as Record<string, any>;
      return (
        e.entityId === filter.taskId ||
        d.task_id === filter.taskId ||
        agentRunTask.get(e.entityId) === filter.taskId ||
        actionTask.get(e.entityId) === filter.taskId
      );
    })
    .map((e) => ({ seq: e.seq, ts: e.ts, kind: e.entity, id: e.entityId, from: e.fromState, to: e.toState, summary: summarize(e) }));
}

// ---- linking an action to the agent run that produced it -----------------------------------------
// Causal first (the integration event records the action id), then the run's own time window for
// in-process runs (their actions happen DURING the run). Never "the latest run started before":
// two runs of one task can share a millisecond.

type Run = ReturnType<Journal["listAgentRuns"]>[number];

function runsForAction(journal: Journal, actionId: string, taskId: string, appliedTs: number | null, events: Ev[]): { runs: Run[]; linkedBy: "integration" | "window" | "task" } {
  const all = journal.listAgentRuns();
  const link = events.find((e) => e.entity === "agent_run_integration" && (e.data as { action_id?: string })?.action_id === actionId);
  if (link) {
    const r = all.find((x) => x.agentRunId === link.entityId);
    if (r) return { runs: [r], linkedBy: "integration" };
  }
  if (appliedTs !== null) {
    const inWindow = all.filter((r) => r.taskId === taskId && r.adapter === "native" && r.startedAt <= appliedTs && appliedTs <= r.finishedAt);
    if (inWindow.length) return { runs: inWindow, linkedBy: "window" };
  }
  return { runs: all.filter((r) => r.taskId === taskId), linkedBy: "task" };
}

// ---- who-changed ------------------------------------------------------------------------------

export interface FileChangeRecord {
  seq: number;
  ts: number;
  actionId: string;
  taskId: string;
  actor: string;
  op: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  agentRun: { id: string; profile: string; adapter: string } | null;
  accepted: boolean | null;
}

export function whoChanged(journal: Journal, path: string): FileChangeRecord[] {
  const events = journal.listEvents();
  const actions = journal.listAllActions();
  const validations = journal.listValidations();
  const lastValidation = validations.at(-1);
  const out: FileChangeRecord[] = [];
  for (const a of actions) {
    if (a.state !== "APPLIED" && a.state !== "RELEASE_PENDING" && a.state !== "SETTLED") continue;
    if (a.errorCode === "STALE_VIEW") continue;
    const f = journal.getActionFiles(a.actionId).find((x) => x.path === path);
    if (!f) continue;
    const applied = events.find((e) => e.entity === "action" && e.entityId === a.actionId && e.toState === "APPLIED");
    if (!applied) continue;
    const run = runsForAction(journal, a.actionId, a.taskId, applied.ts, events).runs.at(-1) ?? null;
    out.push({
      seq: applied.seq,
      ts: applied.ts,
      actionId: a.actionId,
      taskId: a.taskId,
      actor: a.actorOwner,
      op: f.op,
      beforeDigest: f.beforeDigest,
      afterDigest: f.afterDigest,
      agentRun: run ? { id: run.agentRunId, profile: run.profileId, adapter: run.adapter } : null,
      accepted: lastValidation ? lastValidation.valid && lastValidation.exitCode === 0 : null,
    });
  }
  return out.sort((x, y) => x.seq - y.seq);
}

// ---- why ----------------------------------------------------------------------------------------

export interface WhyReport {
  found: boolean;
  actionId: string;
  mission: { objective: string; state: string } | null;
  task: { id: string; objective: string; criteria: string[]; context: string[]; scope: string[]; deps: string[]; state: string } | null;
  /** How the runs were attributed: exact link, in-process time window, or only "same task". */
  linkedBy: "integration" | "window" | "task" | null;
  agentRuns: { id: string; profile: string; adapter: string; role: string; outcome: string; durationMs: number; promptBlob: string | null; usage: { provenance: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null } }[];
  action: {
    state: string;
    files: { path: string; op: string; beforeDigest: string | null; afterDigest: string | null; progress: string }[];
    transitions: { seq: number; ts: number; from: string | null; to: string | null; errorCode: string | null }[];
  } | null;
  /** Words the agent wrote about its own work. Recorded verbatim; NOT evidence. */
  asserted: { seq: number; source: string; text: string }[];
  validations: { id: string; command: string; exitCode: number | null; valid: boolean; snapshotDigest: string }[];
}

export function why(journal: Journal, actionId: string): WhyReport {
  const a = journal.getAction(actionId);
  const empty: WhyReport = { found: false, actionId, mission: null, task: null, linkedBy: null, agentRuns: [], action: null, asserted: [], validations: [] };
  if (!a) return empty;
  const events = journal.listEvents();
  const task = journal.listTasks().find((t) => t.taskId === a.taskId) ?? null;
  const mission = journal.getMission();
  const files = journal.getActionFiles(actionId);
  const last = events.filter((e) => e.entity === "action" && e.entityId === actionId).at(-1);
  const applied = events.find((e) => e.entity === "action" && e.entityId === actionId && e.toState === "APPLIED");
  const linked = runsForAction(journal, actionId, a.taskId, applied?.ts ?? last?.ts ?? null, events);
  const runs = linked.runs;
  return {
    found: true,
    actionId,
    mission: mission ? { objective: mission.objective, state: mission.state } : null,
    task: task
      ? {
          id: task.taskId,
          objective: String(task.spec?.objective ?? ""),
          criteria: task.spec?.criteria ?? [],
          context: task.spec?.context ?? [],
          scope: task.scope,
          deps: task.deps,
          state: task.state,
        }
      : null,
    linkedBy: linked.linkedBy,
    agentRuns: runs.map((r) => ({
      id: r.agentRunId,
      profile: r.profileId,
      adapter: r.adapter,
      role: r.role,
      outcome: r.outcome,
      durationMs: r.durationMs,
      promptBlob: r.promptBlob,
      usage: { provenance: r.usageProvenance, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd },
    })),
    action: {
      state: a.state,
      files: files.map((f) => ({ path: f.path, op: f.op, beforeDigest: f.beforeDigest, afterDigest: f.afterDigest, progress: f.progress })),
      transitions: events
        .filter((e) => e.entity === "action" && e.entityId === actionId)
        .map((e) => ({ seq: e.seq, ts: e.ts, from: e.fromState, to: e.toState, errorCode: ((e.data as { error_code?: string })?.error_code ?? null) as string | null })),
    },
    asserted: events
      .filter((e) => e.entity === "agent_step" && e.entityId === a.taskId && (e.data as { asserted?: string })?.asserted)
      .map((e) => ({ seq: e.seq, source: `agent_step:${(e.data as { tool?: string }).tool}`, text: String((e.data as { asserted: string }).asserted) })),
    validations: journal.listValidations().map((v) => ({ id: v.validationId, command: v.command, exitCode: v.exitCode, valid: v.valid, snapshotDigest: v.snapshotDigest })),
  };
}

// ---- cost ---------------------------------------------------------------------------------------

export interface CostRow {
  key: string;
  runs: number;
  succeeded: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum over runs that REPORTED a USD figure. Runs without one are counted separately, never as 0. */
  usd: number;
  usdKnownRuns: number;
  usdUnknownRuns: number;
  /** Runs whose token usage is entirely unknown. */
  tokensUnknownRuns: number;
  durationMs: number;
}

export function costBy(journal: Journal, dim: "profile" | "task" | "adapter" | "model" | "role"): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const r of journal.listAgentRuns()) {
    const keys = dim === "profile" ? [r.profileId] : dim === "task" ? [r.taskId ?? "(none)"] : dim === "adapter" ? [r.adapter] : dim === "role" ? [r.role] : r.models.length ? r.models : ["(unknown)"];
    for (const key of keys) {
      const c =
        rows.get(key) ??
        { key, runs: 0, succeeded: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, usdKnownRuns: 0, usdUnknownRuns: 0, tokensUnknownRuns: 0, durationMs: 0 };
      c.runs++;
      if (r.outcome === "SUCCEEDED") c.succeeded++;
      c.durationMs += r.durationMs;
      if (r.inputTokens === null && r.outputTokens === null) c.tokensUnknownRuns++;
      c.inputTokens += r.inputTokens ?? 0;
      c.outputTokens += r.outputTokens ?? 0;
      c.cacheReadTokens += r.cacheReadTokens ?? 0;
      c.cacheWriteTokens += r.cacheWriteTokens ?? 0;
      if (r.costUsd === null) c.usdUnknownRuns++;
      else {
        c.usd = round(c.usd + r.costUsd);
        c.usdKnownRuns++;
      }
      rows.set(key, c);
    }
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Orchestration spend that belongs to no agent run: planner/supervisor calls. */
export function orchestrationCost(journal: Journal): { calls: number; promptTokens: number; completionTokens: number; usd: number | null } {
  const calls = journal.listModelCalls().filter((c) => c.role === "supervisor");
  const anyUnknown = calls.some((c) => c.costUsd === null);
  return {
    calls: calls.length,
    promptTokens: calls.reduce((a, c) => a + (c.promptTokens ?? 0), 0),
    completionTokens: calls.reduce((a, c) => a + (c.completionTokens ?? 0), 0),
    usd: anyUnknown ? null : round(calls.reduce((a, c) => a + (c.costUsd ?? 0), 0)),
  };
}

// ---- waste --------------------------------------------------------------------------------------

export interface WasteReport {
  totalRuns: number;
  wastedRuns: { id: string; profile: string; why: string; inputTokens: number | null; outputTokens: number | null; usd: number | null }[];
  wastedTokens: number;
  totalTokens: number;
  /** wastedTokens / totalTokens, or null when there is no token data at all. */
  wasteRatio: number | null;
  wastedUsd: number;
}

export function waste(journal: Journal): WasteReport {
  const integ = new Map<string, string>();
  for (const e of journal.listEvents()) if (e.entity === "agent_run_integration") integ.set(e.entityId, String(e.toState));
  const runs = journal.listAgentRuns();
  const wasted: WasteReport["wastedRuns"] = [];
  for (const r of runs) {
    let why: string | null = null;
    if (r.outcome !== "SUCCEEDED") why = `run ${r.outcome}${r.reason ? `: ${r.reason}` : ""}`;
    else if (r.role === "writer") {
      const s = integ.get(r.agentRunId);
      if (s && !INTEGRATED.has(s) && s !== "NO_CHANGES") why = `not integrated: ${s}`;
      else if (s === "NO_CHANGES") why = "produced no changes";
    }
    if (why) wasted.push({ id: r.agentRunId, profile: r.profileId, why, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usd: r.costUsd });
  }
  const tok = (x: { inputTokens: number | null; outputTokens: number | null }) => (x.inputTokens ?? 0) + (x.outputTokens ?? 0);
  const totalTokens = runs.reduce((a, r) => a + tok(r), 0);
  const wastedTokens = wasted.reduce((a, r) => a + tok(r), 0);
  return {
    totalRuns: runs.length,
    wastedRuns: wasted,
    wastedTokens,
    totalTokens,
    wasteRatio: totalTokens > 0 ? round(wastedTokens / totalTokens, 4) : null,
    wastedUsd: round(wasted.reduce((a, r) => a + (r.usd ?? 0), 0)),
  };
}

// ---- coordination cost ------------------------------------------------------------------------

export interface CoordinationRow {
  taskId: string;
  actions: number;
  waitMs: number;
  waits: number;
  staleViews: number;
  recoveries: number;
}

export function coordination(journal: Journal): CoordinationRow[] {
  const events = journal.listEvents().filter((e) => e.entity === "action");
  const taskOf = new Map(journal.listAllActions().map((a) => [a.actionId, a.taskId]));
  const byTask = new Map<string, CoordinationRow>();
  const get = (t: string) => byTask.get(t) ?? { taskId: t, actions: 0, waitMs: 0, waits: 0, staleViews: 0, recoveries: 0 };
  const waitingSince = new Map<string, number>();
  for (const e of events) {
    const task = taskOf.get(e.entityId) ?? "(unknown)";
    const row = get(task);
    if (e.fromState === null) row.actions++;
    if (e.toState === "WAITING_RESOURCE") {
      waitingSince.set(e.entityId, e.ts);
      row.waits++;
    } else if (waitingSince.has(e.entityId)) {
      row.waitMs += e.ts - (waitingSince.get(e.entityId) as number);
      waitingSince.delete(e.entityId);
    }
    if (e.toState === "STALE_VIEW") row.staleViews++;
    if (e.toState === "RECOVERY_REQUIRED") row.recoveries++;
    byTask.set(task, row);
  }
  return [...byTask.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
}
