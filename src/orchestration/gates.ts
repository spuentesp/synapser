// Approval gates (plan 10 §4). An approval is bound to the DIGEST of the plan it approved: change
// the plan and the approval no longer holds. Approving is a ledger event with actor and moment.

import { digestOfJson } from "../digest/canonical.ts";
import type { Digest } from "../digest/file.ts";
import type { Journal } from "../journal/journal.ts";
import type { Plan } from "../mission/plan.ts";

export type ApprovalStatus = "NONE" | "PENDING" | "APPROVED" | "REJECTED";

/** Digest of the plan AS STORED (JSON round-trip), so a stored revision and its source agree. */
export const planDigest = (plan: Plan | unknown): Digest => digestOfJson(JSON.parse(JSON.stringify(plan)));

/** Digest of the latest accepted plan revision: what an approval must be bound to. */
export const currentPlanDigest = (journal: Journal): Digest => {
  const revs = journal.listPlanRevisions().filter((r) => r.acceptedAt !== null);
  const last = revs[revs.length - 1];
  return planDigest(last ? last.plan : {});
};

interface ApprovalEvent {
  seq: number;
  taskId: string;
  state: "PENDING" | "APPROVED" | "REJECTED";
  planDigest: string;
  actor: string | null;
}

const approvals = (journal: Journal): ApprovalEvent[] =>
  journal
    .listEvents()
    .filter((e) => e.entity === "approval")
    .map((e) => ({
      seq: e.seq,
      taskId: e.entityId,
      state: e.toState as ApprovalEvent["state"],
      planDigest: String((e.data as { plan_digest?: string }).plan_digest ?? ""),
      actor: ((e.data as { actor?: string }).actor ?? null) as string | null,
    }));

/** Latest decision about this task for THIS plan digest; decisions about other digests do not count. */
export function approvalStatus(journal: Journal, taskId: string, digest: string): ApprovalStatus {
  const mine = approvals(journal).filter((a) => a.taskId === taskId && a.planDigest === digest);
  return mine.length === 0 ? "NONE" : (mine[mine.length - 1] as ApprovalEvent).state;
}

/** Idempotent: one PENDING per (task, digest). */
export function requestApproval(journal: Journal, runId: string, taskId: string, digest: string, why?: string): boolean {
  if (approvalStatus(journal, taskId, digest) !== "NONE") return false;
  journal.tx((t) => t.event(runId, "approval", taskId, null, "PENDING", { plan_digest: digest, ...(why ? { why } : {}) }));
  return true;
}

export type DecideResult = { ok: true } | { ok: false; code: "NOT_PENDING" | "STALE_DIGEST" };

export function decideApproval(
  journal: Journal,
  runId: string,
  d: { taskId: string; planDigest: string; currentDigest: string; decision: "APPROVED" | "REJECTED"; actor: string; reason?: string },
): DecideResult {
  if (d.planDigest !== d.currentDigest) return { ok: false, code: "STALE_DIGEST" };
  if (approvalStatus(journal, d.taskId, d.planDigest) !== "PENDING") return { ok: false, code: "NOT_PENDING" };
  journal.tx((t) =>
    t.event(runId, "approval", d.taskId, "PENDING", d.decision, { plan_digest: d.planDigest, actor: d.actor, ...(d.reason ? { reason: d.reason } : {}) }),
  );
  return { ok: true };
}

export function pendingApprovals(journal: Journal, currentDigest: string): string[] {
  const latest = new Map<string, ApprovalEvent>();
  for (const a of approvals(journal)) if (a.planDigest === currentDigest) latest.set(a.taskId, a);
  return [...latest.values()].filter((a) => a.state === "PENDING").map((a) => a.taskId);
}

export { approvals as _approvalEvents };
