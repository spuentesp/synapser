// Approval gates (plan 10 §4). An approval is bound to the DIGEST of the plan it approved: change
// the plan and the approval no longer holds. Approving is a ledger event with actor and moment.

import { createHash, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// ---- out-of-band challenge (plan 13 E2) ----------------------------------------------------------
// An approval that arrives over MCP must carry a code that only the HUMAN channels (UI, CLI) can see.
// The ledger holds the code's hash; the plaintext lives in a 0600 file next to the journal, never in
// an export, an API response to an agent, or an MCP result. An agent that was prompt-injected into
// "approving its own gate" does not know it.

const CH_FILE = "challenges.json";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const chHash = (code: string): string => createHash("sha256").update(code.toUpperCase()).digest("hex");
const chKey = (key: string, digest: string): string => `${key}@${digest}`;

function readChallengeFile(journal: Journal): Record<string, string> {
  const p = join(journal.dir, CH_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function mintChallenge(journal: Journal, runId: string, key: string, digest: string): void {
  const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const file = readChallengeFile(journal);
  file[chKey(key, digest)] = code;
  const p = join(journal.dir, CH_FILE);
  writeFileSync(p, JSON.stringify(file), { mode: 0o600 });
  chmodSync(p, 0o600);
  journal.tx((t) => t.event(runId, "approval_challenge", key, null, "MINTED", { plan_digest: digest, code_sha256: chHash(code) }));
}

/** For HUMAN channels only (UI endpoint, CLI). Never expose through MCP. */
export function readChallenge(journal: Journal, key: string, digest: string): string | null {
  return readChallengeFile(journal)[chKey(key, digest)] ?? null;
}

export function verifyChallenge(journal: Journal, key: string, digest: string, code: string): boolean {
  const ev = journal
    .listEvents()
    .filter((e) => e.entity === "approval_challenge" && e.entityId === key && (e.data as { plan_digest?: string }).plan_digest === digest)
    .at(-1);
  if (!ev || typeof code !== "string" || code.length < 4 || code.length > 16) return false;
  return (ev.data as { code_sha256?: string }).code_sha256 === chHash(code);
}

/** Idempotent: one PENDING per (task, digest). Mints the out-of-band challenge for MCP approvals. */
export function requestApproval(journal: Journal, runId: string, taskId: string, digest: string, why?: string): boolean {
  if (approvalStatus(journal, taskId, digest) !== "NONE") return false;
  journal.tx((t) => t.event(runId, "approval", taskId, null, "PENDING", { plan_digest: digest, ...(why ? { why } : {}) }));
  mintChallenge(journal, runId, taskId, digest);
  return true;
}

export type ApprovalChannel = "ui" | "cli" | "mcp";
export type DecideResult = { ok: true } | { ok: false; code: "NOT_PENDING" | "STALE_DIGEST" | "BAD_CHALLENGE" };

export function decideApproval(
  journal: Journal,
  runId: string,
  d: {
    taskId: string; planDigest: string; currentDigest: string; decision: "APPROVED" | "REJECTED"; actor: string; reason?: string;
    /** Where the decision came from. `mcp` requires the out-of-band challenge. Default `ui` (existing callers). */
    channel?: ApprovalChannel;
    challenge?: string;
  },
): DecideResult {
  if (d.planDigest !== d.currentDigest) return { ok: false, code: "STALE_DIGEST" };
  if (approvalStatus(journal, d.taskId, d.planDigest) !== "PENDING") return { ok: false, code: "NOT_PENDING" };
  const channel = d.channel ?? "ui";
  if (channel === "mcp" && !verifyChallenge(journal, d.taskId, d.planDigest, d.challenge ?? "")) return { ok: false, code: "BAD_CHALLENGE" };
  journal.tx((t) =>
    t.event(runId, "approval", d.taskId, "PENDING", d.decision, { plan_digest: d.planDigest, actor: d.actor, channel, ...(d.reason ? { reason: d.reason } : {}) }),
  );
  return { ok: true };
}

export function pendingApprovals(journal: Journal, currentDigest: string): string[] {
  const latest = new Map<string, ApprovalEvent>();
  for (const a of approvals(journal)) if (a.planDigest === currentDigest) latest.set(a.taskId, a);
  return [...latest.values()].filter((a) => a.state === "PENDING").map((a) => a.taskId);
}

export { approvals as _approvalEvents };
