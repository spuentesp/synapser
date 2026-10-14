// Reverting a task's work (plan 13 §6.3). The system stays roll-FORWARD: a revert is a NEW action that
// goes through the executor like any other (claims, digests, STALE_VIEW, journal), so I1 holds by
// construction. It only restores a file when the file is, today, exactly what the task left there;
// otherwise someone built on top of it and the file is reported as a CONFLICT, never overwritten (R1).

import type { Executor } from "../executor/executor.ts";
import type { Journal } from "../journal/journal.ts";

export type RevertResult = "REVERTED" | "CONFLICT" | "UNSUPPORTED" | "UNCHANGED";

export interface RevertReport {
  taskId: string;
  files: { path: string; result: RevertResult; detail?: string }[];
  actionId: string | null;
  status: "REVERTED" | "PARTIAL" | "NOTHING" | "FAILED";
}

export async function revertTask(o: { executor: Executor; journal: Journal; runId: string; taskId: string; workspaceRoot: string }): Promise<RevertReport> {
  const { journal, executor, taskId } = o;
  const actions = journal
    .listAllActions()
    .filter((a) => a.taskId === taskId && (a.state === "SETTLED" || a.state === "APPLIED"))
    .sort((a, b) => a.actionId.localeCompare(b.actionId, undefined, { numeric: true }));

  // per path: the chain of this task's changes, oldest first
  const chain = new Map<string, { before: string | null; beforeBlob: string | null; after: string | null; afterBlob: string | null }[]>();
  for (const a of actions) {
    for (const f of journal.getActionFiles(a.actionId)) {
      const c = chain.get(f.path) ?? [];
      c.push({ before: f.beforeDigest, beforeBlob: f.beforeBlob, after: f.afterDigest, afterBlob: f.afterBlob });
      chain.set(f.path, c);
    }
  }
  const report: RevertReport = { taskId, files: [], actionId: null, status: "NOTHING" };
  if (chain.size === 0) return report;

  const { observeFile } = await import("../digest/file.ts");
  const { join } = await import("node:path");
  const plan: { path: string; content: string | null }[] = [];
  for (const [path, c] of [...chain].sort(([a], [b]) => a.localeCompare(b))) {
    const first = c[0]!;
    const last = c.at(-1)!;
    const now = observeFile(join(o.workspaceRoot, path));
    const current = now.kind === "absent" ? null : now.kind === "file" ? now.digest : "other";
    if (current === first.before) {
      report.files.push({ path, result: "UNCHANGED", detail: "already as it was before the task" });
      continue;
    }
    if (current !== last.after) {
      report.files.push({ path, result: "CONFLICT", detail: "changed after this task: reverting would destroy someone else's work" });
      continue;
    }
    if (first.before === null) {
      plan.push({ path, content: null }); // the task created it: revert = delete
      continue;
    }
    const bytes = first.beforeBlob ? executor.readBlob(first.beforeBlob) : null;
    let text: string | null = null;
    try {
      text = bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
    } catch {
      text = null;
    }
    if (text === null) {
      report.files.push({ path, result: "UNSUPPORTED", detail: "the original content is binary or unavailable" });
      continue;
    }
    plan.push({ path, content: text });
  }

  if (plan.length === 0) {
    report.status = report.files.some((f) => f.result === "CONFLICT" || f.result === "UNSUPPORTED") ? "PARTIAL" : "NOTHING";
    return report;
  }

  // one atomic compensating action, under its own identity so it never collides with the task's claims
  const rb = `${taskId}~rollback`;
  const session = executor.beginSession({ taskId: rb, scope: plan.map((p) => p.path), planRevision: 1 });
  const read = await executor.readFiles(rb, session.incarnation, plan.map((p) => p.path));
  if (read.kind !== "ok") {
    report.status = "FAILED";
    report.files.push(...plan.map((p) => ({ path: p.path, result: "CONFLICT" as const, detail: `could not read: ${read.kind === "rejected" ? read.code : "busy"}` })));
    return report;
  }
  const edits = plan.map((p) => (p.content === null ? ({ op: "delete_file", path: p.path } as const) : ({ op: "write_file", path: p.path, content: p.content } as const)));
  const prop = await executor.proposePatch(rb, session.incarnation, read.viewId, edits);
  if (prop.kind !== "ok") {
    report.status = "FAILED";
    report.files.push(...plan.map((p) => ({ path: p.path, result: "CONFLICT" as const, detail: `could not prepare: ${prop.code}` })));
    return report;
  }
  const receipt = await executor.applyAction({ actionId: prop.actionId, requestDigest: prop.requestDigest, incarnation: session.incarnation }, { maxAttempts: 4, backoffMs: 100 });
  report.actionId = prop.actionId;
  const ok = receipt.status === "SETTLED" || receipt.status === "APPLIED";
  for (const p of plan) report.files.push({ path: p.path, result: ok ? "REVERTED" : "CONFLICT", ...(ok ? {} : { detail: `revert action ended ${receipt.status}${receipt.error_code ? ` (${receipt.error_code})` : ""}` }) });
  report.files.sort((a, b) => a.path.localeCompare(b.path));
  report.status = !ok ? "FAILED" : report.files.some((f) => f.result === "CONFLICT" || f.result === "UNSUPPORTED") ? "PARTIAL" : "REVERTED";
  return report;
}
