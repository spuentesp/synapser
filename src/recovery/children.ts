// Orphaned subprocesses of a dead executor (plan 04 §1, review fix #4). A pid alone is NOT an
// identity: it can be reused by an unrelated process. A child is ours only if the pid exists AND
// its start time (field 22 of /proc/<pid>/stat) equals the one recorded when we spawned it.

import { readFileSync } from "node:fs";
import type { ChildRow, Journal } from "../journal/journal.ts";

/** Start time of `pid` in clock ticks since boot, or null if the process does not exist. */
export function procStartTicks(pid: number): number | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // comm is parenthesized and may contain spaces or ')': split after the LAST ')'.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(rest[19]); // field 22 overall = index 19 after the 3 leading fields
  return Number.isFinite(ticks) ? ticks : null;
}

export interface ReapOutcome {
  pid: number;
  kind: string;
  result: "KILLED" | "ALREADY_GONE" | "PID_REUSED_IGNORED" | "KILL_FAILED";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kill children recorded by a previous generation, only when they are provably ours, and wait
 * for their exit. Unrelated processes that reuse a recorded pid are never signalled.
 */
export async function reapStaleChildren(
  journal: Journal,
  currentGeneration: number,
  opts: { graceMs?: number } = {},
): Promise<ReapOutcome[]> {
  const out: ReapOutcome[] = [];
  for (const c of journal.listChildren()) {
    if (c.generation >= currentGeneration) continue;
    out.push(await reapOne(c, opts.graceMs ?? 3000));
    journal.tx((t) => t.removeChild(c.pid));
  }
  return out;
}

async function reapOne(c: ChildRow, graceMs: number): Promise<ReapOutcome> {
  const now = procStartTicks(c.pid);
  if (now === null) return { pid: c.pid, kind: c.kind, result: "ALREADY_GONE" };
  if (now !== c.procStartTicks) return { pid: c.pid, kind: c.kind, result: "PID_REUSED_IGNORED" };
  try {
    // negative pid = the whole process group the child was started in
    process.kill(c.pgid > 1 ? -c.pgid : c.pid, "SIGKILL");
  } catch {
    return { pid: c.pid, kind: c.kind, result: "KILL_FAILED" };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (procStartTicks(c.pid) !== c.procStartTicks) return { pid: c.pid, kind: c.kind, result: "KILLED" };
    await sleep(20);
  }
  return { pid: c.pid, kind: c.kind, result: "KILL_FAILED" };
}
