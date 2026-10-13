// The only module that writes the workspace (design §7, plan 02). It knows nothing about Zoo or
// the journal: it receives a plan whose paths were already contained and whose bytes were
// resolved at PREPARE time. Sequence per file: temp in the SAME directory → fsync → chmod →
// rename → fsync dir. The caller re-hashes after each step.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir } from "../journal/artifacts.ts";

export interface FileWrite {
  path: string; // workspace-relative, already contained
  op: "create" | "replace" | "delete";
  after: Buffer | null;
  afterMode: number | null;
  tmpName: string;
}

export function absPath(workspaceRoot: string, rel: string): string {
  return join(workspaceRoot, ...rel.split("/"));
}

/** Write the temp file but do not rename yet (lets the caller place a failpoint in between). */
export function stageFile(workspaceRoot: string, w: FileWrite): { tmp: string; final: string } | null {
  if (w.op === "delete") return null;
  if (w.after === null) throw new Error(`no content for ${w.path}`);
  const final = absPath(workspaceRoot, w.path);
  const dir = dirname(final);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, w.tmpName);
  try {
    unlinkSync(tmp); // leftover from an earlier attempt of this same action
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let off = 0;
    while (off < w.after.length) off += writeSync(fd, w.after, off, w.after.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, w.afterMode ?? 0o644);
  return { tmp, final };
}

export function commitFile(workspaceRoot: string, w: FileWrite, staged: { tmp: string; final: string } | null): void {
  if (w.op === "delete") {
    const final = absPath(workspaceRoot, w.path);
    unlinkSync(final);
    fsyncDir(dirname(final));
    return;
  }
  if (!staged) throw new Error("commit without stage");
  renameSync(staged.tmp, staged.final);
  fsyncDir(dirname(staged.final));
}
