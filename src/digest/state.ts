// Digest of the state of a set of paths (plan 03 §3): used for task scope and for whole-tree
// snapshots. Mode is part of state identity, unlike the content digest.

import { createHash } from "node:crypto";
import { cmpCodePoints } from "./canonical.ts";
import type { Digest } from "./file.ts";

export interface StateEntry {
  path: string;
  /** `null` = the path does not exist. */
  digest: Digest | null;
  mode: number | null;
}

export function stateDigest(entries: readonly StateEntry[]): Digest {
  const sorted = [...entries].sort((a, b) => cmpCodePoints(a.path, b.path));
  const h = createHash("sha256");
  let prev: string | undefined;
  for (const e of sorted) {
    if (e.path === prev) throw new Error(`duplicate path in state digest: ${e.path}`);
    if (e.path.includes("\n") || e.path === "") throw new Error(`invalid path in state digest: ${JSON.stringify(e.path)}`);
    if ((e.digest === null) !== (e.mode === null)) throw new Error(`digest/mode mismatch for ${e.path}`);
    const mode = (e.mode ?? 0).toString(8).padStart(4, "0");
    h.update(`${mode} ${e.digest ?? "absent"} ${e.path}\n`, "utf8");
    prev = e.path;
  }
  return `sha256:${h.digest("hex")}` as Digest;
}
