// L1 of the Zoanthrope hook-up (plan 11 §1): the runner declares, on the agent's behalf, what a task
// is about to do — BEFORE its first write — so other agents (and the audit) can see the intention.
// Observability only: a failure to announce never fails a task, but it is on the ledger.

import type { Journal } from "../journal/journal.ts";
import type { WorkspacePath } from "../workspace/paths.ts";
import type { ZooAdapter } from "./adapter.ts";

export interface IntentSink {
  announce(actor: string, title: string, note: string, files: readonly string[]): Promise<{ postId: string }>;
}

export const zooIntentSink = (zoo: Pick<ZooAdapter, "postIntention">): IntentSink => ({
  announce: (actor, title, note, files) =>
    zoo.postIntention(actor, title, note, files.map((f) => (f.endsWith("/") ? f.slice(0, -1) : f)) as WorkspacePath[]),
});

/** Announce and RECORD (ledger first-class: either `intent_posted` or `intent_failed`). */
export async function announceIntent(
  sink: IntentSink,
  journal: Journal,
  runId: string,
  task: { taskId: string; objective: string; scope: readonly string[]; criteria: readonly string[] },
): Promise<void> {
  const actor = `${runId}:${task.taskId}`;
  try {
    const r = await sink.announce(actor, task.objective.slice(0, 120), `scope: ${task.scope.join(", ")}\ncriteria: ${task.criteria.join("; ")}`.slice(0, 600), task.scope);
    journal.tx((t) => t.event(runId, "intent", task.taskId, null, "POSTED", { actor, post_id: r.postId }));
  } catch (e) {
    journal.tx((t) => t.event(runId, "intent", task.taskId, null, "FAILED", { actor, error: String((e as Error).message ?? e).slice(0, 200) }));
  }
}
