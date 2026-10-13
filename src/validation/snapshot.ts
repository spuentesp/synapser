// Consistent snapshots of the workspace for validation (plan 03 §5, S11/S18). The digest is
// computed over the COPY that is actually tested, and the live tree is hashed before and after:
// a mismatch means something wrote while we were copying and the snapshot is not trustworthy.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDigest, type StateEntry } from "../digest/state.ts";
import { type Digest, observeFile } from "../digest/file.ts";
import { TMP_PREFIX } from "../workspace/paths.ts";

/** Top-level names that are never part of the product being validated. */
export const SNAPSHOT_EXCLUDE = new Set([".git", ".zoanthrope", ".synapser", "__pycache__", "node_modules", ".pytest_cache"]);

export function listTree(root: string, rel = "", out: string[] = []): string[] {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUDE.has(e.name) || e.name.startsWith(TMP_PREFIX)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listTree(root, r, out);
    else if (e.isFile()) out.push(r);
    // symlinks and specials are not part of a snapshot (MVP forbids them in the workspace)
  }
  return out.sort();
}

export function treeEntries(root: string, files: string[]): StateEntry[] {
  return files.map((p) => {
    const o = observeFile(join(root, p));
    if (o.kind !== "file") return { path: p, digest: null, mode: null };
    return { path: p, digest: o.digest, mode: o.mode };
  });
}

export function treeDigest(root: string): Digest {
  return stateDigest(treeEntries(root, listTree(root)));
}

export interface Snapshot {
  dir: string;
  digest: Digest;
  files: string[];
  /** Live tree digest equalled the copy's: no write raced the copy. */
  consistent: boolean;
}

export function takeSnapshot(
  workspaceRoot: string,
  destDir: string,
  attempts = 3,
  hooks: { afterCopy?: (attempt: number) => void } = {},
): Snapshot {
  for (let i = 0; i < attempts; i++) {
    const files = listTree(workspaceRoot);
    const before = stateDigest(treeEntries(workspaceRoot, files));
    for (const f of files) {
      const dst = join(destDir, f);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(workspaceRoot, f), dst);
    }
    hooks.afterCopy?.(i);
    const copyDigest = stateDigest(treeEntries(destDir, files));
    const after = treeDigest(workspaceRoot);
    if (before === copyDigest && after === copyDigest) return { dir: destDir, digest: copyDigest, files, consistent: true };
  }
  const files = listTree(workspaceRoot);
  return { dir: destDir, digest: stateDigest(treeEntries(destDir, files)), files, consistent: false };
}
