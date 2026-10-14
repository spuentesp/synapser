// Orchestration invariants W1–W4 (plan 10 §6) as checkers over the ledger. W6/W7 are properties of
// pure functions and are proven by property tests, not by a ledger scan.

import type { Violation } from "../audit/invariants.ts";
import type { Journal } from "../journal/journal.ts";
import type { Alert } from "./router.ts";
import type { ProfileCard, StepKind } from "./catalog.ts";
import { _approvalEvents } from "./gates.ts";

export interface DispatchRecord {
  taskId: string;
  profileId: string;
  kind: StepKind;
  reason: "policy" | "suggestion";
  suggested: string | null;
  costBasis: "known" | "estimated" | "unknown";
  /** Tier of the profile actually chosen. */
  tier?: string;
  planDigest: string;
  gates: string[];
  alerts: Alert[];
}

/** Ledger entry written at admission: WHAT was chosen, WHY, and under which plan. */
export function recordDispatch(journal: Journal, runId: string, d: DispatchRecord): void {
  journal.tx((t) => {
    t.event(runId, "dispatch", d.taskId, null, "ROUTED", {
      profile: d.profileId,
      kind: d.kind,
      reason: d.reason,
      suggested: d.suggested,
      cost_basis: d.costBasis,
      ...(d.tier ? { tier: d.tier } : {}),
      plan_digest: d.planDigest,
      gates: d.gates,
    });
    for (const a of d.alerts) t.event(runId, "alert", d.taskId, null, a.code, { profile: a.profileId, detail: a.detail ?? null });
  });
}

interface DispatchEvent {
  seq: number;
  taskId: string;
  profile: string;
  kind: string;
  costBasis: string;
  planDigest: string;
  gates: string[];
}
const dispatches = (journal: Journal): DispatchEvent[] =>
  journal
    .listEvents()
    .filter((e) => e.entity === "dispatch")
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      return {
        seq: e.seq,
        taskId: e.entityId,
        profile: String(d["profile"]),
        kind: String(d["kind"]),
        costBasis: String(d["cost_basis"]),
        planDigest: String(d["plan_digest"]),
        gates: (d["gates"] as string[] | undefined) ?? [],
      };
    });

/** W1: every dispatch used a profile that exists, is enabled and can do that kind of step. */
export function checkDispatch(journal: Journal, catalog: readonly ProfileCard[]): Violation[] {
  const out: Violation[] = [];
  for (const d of dispatches(journal)) {
    const card = catalog.find((c) => c.id === d.profile);
    const why = !card ? "PROFILE_UNKNOWN" : !card.enabled ? "PROFILE_DISABLED" : !card.kinds.includes(d.kind as StepKind) ? "PROFILE_KIND_MISMATCH" : null;
    if (why) out.push({ invariant: "W1", code: why, where: d.taskId, detail: { seq: d.seq, profile: d.profile, kind: d.kind } });
  }
  return out;
}

/** W2: a non-write step changed nothing — no action, no recorded file change. */
export function checkAdvisorsReadOnly(journal: Journal): Violation[] {
  const nonWrite = new Set(dispatches(journal).filter((d) => d.kind !== "write").map((d) => d.taskId));
  const out: Violation[] = [];
  for (const a of journal.listAllActions()) {
    if (nonWrite.has(a.taskId)) out.push({ invariant: "W2", code: "ADVISOR_WROTE", where: a.taskId, detail: { action: a.actionId } });
  }
  for (const r of journal.listAgentRuns()) {
    if (r.taskId && nonWrite.has(r.taskId) && r.changes.length > 0) {
      out.push({ invariant: "W2", code: "ADVISOR_CHANGED_FILES", where: r.taskId, detail: { run: r.agentRunId, files: r.changes.map((c) => c.path) } });
    }
  }
  return out;
}

/** W3: a gated step started only after an approval for the digest of the plan it ran under. */
export function checkGates(journal: Journal): Violation[] {
  const all = _approvalEvents(journal);
  const out: Violation[] = [];
  for (const d of dispatches(journal)) {
    if (!d.gates.includes("approval")) continue;
    const before = all.filter((a) => a.taskId === d.taskId && a.planDigest === d.planDigest && a.seq < d.seq);
    const last = before[before.length - 1];
    if (!last || last.state !== "APPROVED") {
      out.push({ invariant: "W3", code: last ? `GATE_${last.state}` : "GATE_NOT_REQUESTED", where: d.taskId, detail: { seq: d.seq, plan_digest: d.planDigest } });
    }
  }
  return out;
}

/** W4: known spend within the limit; every unknown-cost dispatch raised its alert. */
export function checkBudget(journal: Journal, opts: { budgetUsd?: number } = {}): Violation[] {
  const out: Violation[] = [];
  if (opts.budgetUsd !== undefined) {
    const spent = journal.listAgentRuns().reduce((n, r) => n + (r.costUsd !== null && r.usageProvenance !== "unknown" ? r.costUsd : 0), 0);
    if (spent > opts.budgetUsd + 1e-9) out.push({ invariant: "W4", code: "OVER_BUDGET", where: "run", detail: { spentKnownUsd: spent, budgetUsd: opts.budgetUsd } });
  }
  const alerted = new Set(journal.listEvents().filter((e) => e.entity === "alert" && e.toState === "COST_UNKNOWN").map((e) => e.entityId));
  for (const d of dispatches(journal)) {
    if (d.costBasis === "unknown" && !alerted.has(d.taskId)) out.push({ invariant: "W4", code: "UNKNOWN_COST_WITHOUT_ALERT", where: d.taskId, detail: { seq: d.seq } });
  }
  return out;
}

/**
 * Z3 (plan 11): when intents are enabled, a task's intention is on the ledger BEFORE its first write.
 * Judged on ledger order alone — Zoanthrope's own audit is not a premise (Z1).
 */
export function checkIntentBeforeWrite(journal: Journal): Violation[] {
  const events = journal.listEvents();
  if (!events.some((e) => e.entity === "intent_policy")) return [];
  const taskOf = new Map<string, string>();
  const firstWrite = new Map<string, number>();
  const intent = new Map<string, number>();
  for (const e of events) {
    if (e.entity === "action" && e.toState === "PREPARED") taskOf.set(e.entityId, String((e.data as { task_id?: string }).task_id));
    if (e.entity === "action" && e.toState === "EXECUTING") {
      const t = taskOf.get(e.entityId);
      if (t !== undefined && !firstWrite.has(t)) firstWrite.set(t, e.seq);
    }
    if (e.entity === "intent" && !intent.has(e.entityId)) intent.set(e.entityId, e.seq);
  }
  const out: Violation[] = [];
  for (const [task, wseq] of firstWrite) {
    const iseq = intent.get(task);
    if (iseq === undefined) out.push({ invariant: "Z3", code: "NO_INTENT", where: task, detail: { firstWriteSeq: wseq } });
    else if (iseq > wseq) out.push({ invariant: "Z3", code: "INTENT_AFTER_WRITE", where: task, detail: { intentSeq: iseq, firstWriteSeq: wseq } });
  }
  return out;
}

/** Z4: every claim alive in Zoanthrope that belongs to this run maps to an unreconciled action. */
export function checkNoSilentOrphans(journal: Journal, claims: readonly { agent: string; path: string }[]): Violation[] {
  const out: Violation[] = [];
  const prefix = `${journal.runId}:`;
  for (const c of claims) {
    if (!c.agent.startsWith(prefix)) continue;
    const actor = c.agent.replace(/#r$/, "");
    const held = journal.unreconciledForActor(actor).flatMap((a) => journal.getActionFiles(a.actionId).map((f) => f.path));
    if (!held.includes(c.path)) out.push({ invariant: "Z4", code: "ORPHAN_CLAIM", where: c.path, detail: { agent: c.agent } });
  }
  return out;
}
