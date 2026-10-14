// Executable invariants (docs/plans/09). Each checker is a pure function over RECORDED facts and
// returns violations with evidence; an empty array is the proof for that run. They are used by the
// tests AND by the A/B bench, in both arms, so "0 vs N" is computed by the same code.
//
//   I1 lineage      per path, every write was based on exactly what the previous write left there
//                   (violation = lost update). Needs no oracle.
//   I2 grant        no action reached EXECUTING without having been CLAIMED first.
//   I3 foreign      (enforced in the executor; see recovery tests) — here: nothing was written
//                   over bytes that were neither predicted before nor after.
//   I4 acceptance   a task is DONE only with a passing validation on a valid snapshot.
//   I5 chain        the ledger's hash chain verifies.

import { readFileSync } from "node:fs";
import { ABSENT, type DigestOrAbsent, observeFile } from "../digest/file.ts";
import type { Journal } from "../journal/journal.ts";
import { absPath } from "../executor/fs-applier.ts";
import { verify } from "./queries.ts";

/** One write to the shared tree, observed independently of whichever component performed it. */
export interface WriteRecord {
  seq: number;
  path: string;
  actor: string;
  /** Digest of the content the writer's edit was computed from (what the agent READ). */
  basedOn: DigestOrAbsent;
  /** Digest actually on disk immediately before the write. */
  onDiskBefore: DigestOrAbsent | "other";
  /** Digest written (ABSENT for a delete). */
  written: DigestOrAbsent;
  /** Optional text of the three states, to tell an unsafe write from an actual loss of content. */
  basedOnText?: string | null;
  onDiskBeforeText?: string | null;
  writtenText?: string | null;
}

const lines = (t: string | null | undefined): Set<string> =>
  new Set((t ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0));

/**
 * Lines that were on disk, that this writer did not know about (absent from its base), and that
 * its write erased. Non-empty = another agent's work was actually destroyed, not just risked.
 */
export function lostLines(w: WriteRecord): string[] {
  if (w.onDiskBeforeText === undefined || w.basedOnText === undefined || w.writtenText === undefined) return [];
  const base = lines(w.basedOnText);
  const after = lines(w.writtenText);
  return [...lines(w.onDiskBeforeText)].filter((l) => !base.has(l) && !after.has(l));
}

export interface Violation {
  invariant: "I1" | "I2" | "I3" | "I4" | "I5" | "W1" | "W2" | "W3" | "W4" | "W5" | "Z3" | "Z4";
  code: string;
  where: string;
  detail: Record<string, unknown>;
}

export const digestOnDisk = (root: string, path: string): DigestOrAbsent | "other" => {
  const o = observeFile(absPath(root, path));
  return o.kind === "absent" ? ABSENT : o.kind === "file" ? (o.digest as DigestOrAbsent) : "other";
};

/**
 * I1. `initial` is the digest of each path before the run. A write is a lost update when the edit
 * it applied was computed from something other than what the previous write left (or the initial
 * content): every change in between was silently overwritten.
 */
export function checkLineage(trace: readonly WriteRecord[], initial: ReadonlyMap<string, DigestOrAbsent>): Violation[] {
  const out: Violation[] = [];
  const head = new Map(initial);
  for (const w of [...trace].sort((a, b) => a.seq - b.seq)) {
    const expected = head.get(w.path) ?? ABSENT;
    if (w.basedOn !== expected) {
      out.push({
        invariant: "I1",
        code: "LOST_UPDATE",
        where: w.path,
        detail: { seq: w.seq, writer: w.actor, basedOn: w.basedOn, tree_had: expected, lostLines: lostLines(w) },
      });
    }
    if (w.onDiskBefore !== expected) {
      out.push({ invariant: "I3", code: "UNPREDICTED_BYTES_OVERWRITTEN", where: w.path, detail: { seq: w.seq, writer: w.actor, expected, onDisk: w.onDiskBefore } });
    }
    head.set(w.path, w.written);
  }
  return out;
}

/** I2 over the ledger: every EXECUTING transition of an action is preceded by its CLAIMED one. */
export function checkGrantBeforeWrite(journal: Journal): Violation[] {
  const out: Violation[] = [];
  const claimed = new Set<string>();
  for (const e of journal.listEvents()) {
    if (e.entity !== "action") continue;
    if (e.toState === "CLAIMED") claimed.add(e.entityId);
    if (e.toState === "EXECUTING" && !claimed.has(e.entityId)) {
      out.push({ invariant: "I2", code: "WRITE_WITHOUT_GRANT", where: e.entityId, detail: { seq: e.seq } });
    }
  }
  return out;
}

/**
 * I4: a task is DONE only through acceptance evidence. Agent tasks are completed BY a validation
 * task (the DONE event names it in `by`); that validation task must own at least one validation
 * and every one of them must be valid and exit 0. A validation task's own DONE is checked directly.
 */
export function checkAcceptance(journal: Journal): Violation[] {
  const byTask = new Map<string, { valid: boolean; exitCode: number | null }[]>();
  for (const v of journal.listValidations()) (byTask.get(v.taskId) ?? byTask.set(v.taskId, []).get(v.taskId)!).push(v);
  const passes = (taskId: string): boolean => {
    const vs = byTask.get(taskId) ?? [];
    return vs.length > 0 && vs.every((v) => v.valid && v.exitCode === 0);
  };
  const out: Violation[] = [];
  for (const e of journal.listEvents()) {
    if (e.entity !== "task" || e.toState !== "DONE") continue;
    const by = (e.data as { by?: string }).by;
    const evidence = by ?? e.entityId;
    if (!passes(evidence)) {
      out.push({ invariant: "I4", code: "DONE_WITHOUT_ACCEPTANCE", where: e.entityId, detail: { seq: e.seq, evidence } });
    }
  }
  return out;
}

/** I5. */
export function checkChain(journal: Journal): Violation[] {
  const v = verify(journal);
  return v.ok ? [] : [{ invariant: "I5", code: "CHAIN_BROKEN", where: `seq ${String(v.firstBadSeq)}`, detail: { reason: v.reason } }];
}

/**
 * Collects the independent write trace of an Executor-backed run. Wire `hook` as
 * `ExecutorDeps.beforeRename`; it observes the disk immediately before each rename.
 */
export function executorTrace(journal: Journal, root: string): { hook: NonNullable<import("../executor/executor.ts").ExecutorDeps["beforeRename"]>; trace: WriteRecord[] } {
  const trace: WriteRecord[] = [];
  let seq = 0;
  const hook = ({ actionId, actor, path }: { actionId: string; actor: string; path: string }) => {
    const f = journal.getActionFiles(actionId).find((x) => x.path === path);
    if (!f) return;
    const blob = (ref: string | null): string | null => {
      if (!ref) return null;
      try {
        return journal.artifacts.get(ref).toString("utf8");
      } catch {
        return null;
      }
    };
    let onDiskText: string | null = null;
    try {
      onDiskText = readFileSync(absPath(root, path), "utf8");
    } catch {
      /* absent */
    }
    trace.push({
      seq: ++seq,
      path,
      actor,
      basedOn: (f.beforeDigest ?? ABSENT) as DigestOrAbsent,
      onDiskBefore: digestOnDisk(root, path),
      written: (f.afterDigest ?? ABSENT) as DigestOrAbsent,
      basedOnText: blob(f.beforeBlob),
      onDiskBeforeText: onDiskText,
      writtenText: blob(f.afterBlob),
    });
  };
  return { hook, trace };
}
