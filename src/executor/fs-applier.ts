// The only module that writes the workspace (design §7, plan 02). It knows nothing about Zoo or
// the journal: it receives a plan whose paths were already contained and whose bytes were
// resolved at PREPARE time. Sequence per file: temp in the SAME directory → write/chmod → fsync →
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

/** The durability boundary for workspace writes; tests may model power loss at sync points. */
export interface WorkspaceDurability {
  syncFile(fd: number, path: string): void;
  syncDirectory(path: string): void;
}

export const NODE_WORKSPACE_DURABILITY: WorkspaceDurability = {
  syncFile: fsyncSync,
  syncDirectory: fsyncDir,
};

export function absPath(workspaceRoot: string, rel: string): string {
  return join(workspaceRoot, ...rel.split("/"));
}

/** Write the temp file but do not rename yet (lets the caller place a failpoint in between). */
export function stageFile(workspaceRoot: string, w: FileWrite, durability: WorkspaceDurability = NODE_WORKSPACE_DURABILITY): { tmp: string; final: string } | null {
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
    chmodSync(tmp, w.afterMode ?? 0o644);
    durability.syncFile(fd, tmp);
  } finally {
    closeSync(fd);
  }
  return { tmp, final };
}

export function commitFile(workspaceRoot: string, w: FileWrite, staged: { tmp: string; final: string } | null, durability: WorkspaceDurability = NODE_WORKSPACE_DURABILITY): void {
  if (w.op === "delete") {
    const final = absPath(workspaceRoot, w.path);
    unlinkSync(final);
    durability.syncDirectory(dirname(final));
    return;
  }
  if (!staged) throw new Error("commit without stage");
  renameSync(staged.tmp, staged.final);
  durability.syncDirectory(dirname(staged.final));
}
