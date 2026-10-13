// Patch broker: the ONLY way an external agent's work reaches the workspace. It turns the change
// set of an isolated run into edits against the BASE the agent was given, then lets the executor
// arbitrate: scope, claims (Zoanthrope), digest check (STALE_VIEW if the live tree moved since the
// copy), atomic apply, journal. An advisor's changes are never integrated.

import type { Edit } from "../digest/canonical.ts";
import type { ActionReceipt, Executor } from "../executor/executor.ts";
import type { AgentRunResult } from "./runner.ts";

export type IntegrationStatus =
  | "INTEGRATED"
  | "NO_CHANGES"
  | "NOT_INTEGRATED" // the run itself did not succeed, or the profile may not write
  | "UNSUPPORTED_CHANGE" // binary / too large
  | "REJECTED" // scope, path, patch rules
  | "STALE_VIEW" // live files changed since the agent's copy: rebase / re-run
  | "WAITING_RESOURCE"
  | "FAILED";

export interface IntegrationResult {
  status: IntegrationStatus;
  detail: string | null;
  files: string[];
  receipt: ActionReceipt | null;
}

export async function integrateRun(
  executor: Executor,
  task: { taskId: string; incarnation: number },
  run: AgentRunResult,
  opts: { allowUnknownOutcome?: boolean; applyAttempts?: number } = {},
): Promise<IntegrationResult> {
  const none = (status: IntegrationStatus, detail: string | null = null, files: string[] = []): IntegrationResult => ({ status, detail, files, receipt: null });

  if (run.role !== "writer") return none("NOT_INTEGRATED", `profile role is ${run.role}: advisors never write`);
  if (run.outcome !== "SUCCEEDED" && !(opts.allowUnknownOutcome && run.outcome === "UNKNOWN")) {
    return none("NOT_INTEGRATED", `run outcome ${run.outcome}${run.reason ? `: ${run.reason}` : ""}`);
  }
  if (!run.baseConsistent) return none("NOT_INTEGRATED", "the base copy was not consistent (a write raced the copy)");
  if (run.changes.length === 0) return none("NO_CHANGES");
  const bad = run.changes.find((c) => c.unsupported);
  if (bad) return none("UNSUPPORTED_CHANGE", `${bad.path}: ${bad.unsupported}`, run.changes.map((c) => c.path));

  const files = run.changes.map((c) => c.path);
  // 1. the view the agent had: the base content, not whatever is on disk now
  const entries = run.changes.map((c) => ({
    path: c.path,
    bytes: c.op === "create" || c.beforeBlob === null ? null : executor.readBlob(c.beforeBlob),
    mode: c.mode,
  }));
  const view = executor.registerView(task.taskId, task.incarnation, entries);
  if (view.kind === "rejected") return none("REJECTED", `${view.code}${view.detail ? ` ${view.detail}` : ""}`, files);

  // 2. the change as exact edits
  const edits: Edit[] = run.changes.map((c) =>
    c.op === "delete" ? { op: "delete_file", path: c.path } : { op: "write_file", path: c.path, content: executor.readBlob(c.afterBlob as string)?.toString("utf8") ?? "" },
  );
  const p = await executor.proposePatch(task.taskId, task.incarnation, view.viewId, edits);
  if (p.kind === "rejected") return none("REJECTED", `${p.code}${p.detail ? ` ${p.detail}` : ""}`, files);

  // 3. arbitration + atomic apply
  const r = await executor.applyAction(
    { actionId: p.actionId, requestDigest: p.requestDigest, incarnation: task.incarnation },
    { maxAttempts: opts.applyAttempts ?? 3, backoffMs: 100 },
  );
  const base = { detail: r.error_code, files, receipt: r };
  if (r.status === "SETTLED" || r.status === "APPLIED") return { ...base, status: "INTEGRATED" };
  if (r.status === "STALE_VIEW") return { ...base, status: "STALE_VIEW" };
  if (r.status === "WAITING_RESOURCE") return { ...base, status: "WAITING_RESOURCE" };
  return { ...base, status: "FAILED" };
}
