// Resolve an agent's edits to final bytes at PREPARE time (plan 03 §4). The executor never
// re-applies edits later: recovery compares disk with before/after digests and writes `after_blob`.

import type { Edit } from "./canonical.ts";
import { MAX_ACTION_FILE_BYTES } from "./file.ts";

export type PatchErrorCode =
  | "PATCH_DOES_NOT_APPLY" // old text missing, or the file is absent
  | "PATCH_AMBIGUOUS" // old text appears more than once
  | "PATCH_NOT_UTF8"
  | "PATCH_CONFLICTING_OPS"
  | "FILE_TOO_LARGE"
  | "EMPTY_OLD";

export class PatchRejected extends Error {
  readonly code: PatchErrorCode;
  readonly path: string;
  constructor(code: PatchErrorCode, path: string, detail?: string) {
    super(`patch rejected (${code}) on ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "PatchRejected";
    this.code = code;
    this.path = path;
  }
}

export type FileOp = "create" | "replace" | "delete";
export interface Resolved {
  path: string;
  op: FileOp;
  before: Buffer | null;
  /** `null` = file ends up deleted. */
  after: Buffer | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function asText(path: string, b: Buffer): string {
  try {
    return utf8.decode(b);
  } catch {
    throw new PatchRejected("PATCH_NOT_UTF8", path);
  }
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * @param views what the agent read: path → bytes (`null` if the file did not exist).
 *              Every edited path must be present, or the agent is editing blind.
 */
export function resolveEdits(views: ReadonlyMap<string, Buffer | null>, edits: readonly Edit[]): Resolved[] {
  const byPath = new Map<string, Edit[]>();
  for (const e of edits) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }
  const out: Resolved[] = [];
  for (const [path, list] of [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!views.has(path)) throw new PatchRejected("PATCH_DOES_NOT_APPLY", path, "no view of this file");
    const before = views.get(path) ?? null;
    if (list.some((e) => e.op === "delete_file") && list.length > 1) {
      throw new PatchRejected("PATCH_CONFLICTING_OPS", path, "delete_file must be the only edit");
    }
    let cur: Buffer | null = before;
    for (const e of list) {
      if (e.op === "delete_file") {
        if (cur === null) throw new PatchRejected("PATCH_DOES_NOT_APPLY", path, "file is absent");
        cur = null;
      } else if (e.op === "write_file") {
        cur = Buffer.from(e.content, "utf8");
      } else {
        if (cur === null) throw new PatchRejected("PATCH_DOES_NOT_APPLY", path, "file is absent");
        if (e.old === "") throw new PatchRejected("EMPTY_OLD", path);
        const text = asText(path, cur);
        const n = countOccurrences(text, e.old);
        if (n === 0) throw new PatchRejected("PATCH_DOES_NOT_APPLY", path, "old text not found");
        if (n > 1) throw new PatchRejected("PATCH_AMBIGUOUS", path, `old text appears ${n} times`);
        const i = text.indexOf(e.old);
        cur = Buffer.from(text.slice(0, i) + e.new + text.slice(i + e.old.length), "utf8");
      }
    }
    if (cur !== null && cur.length > MAX_ACTION_FILE_BYTES) throw new PatchRejected("FILE_TOO_LARGE", path);
    const op: FileOp = cur === null ? "delete" : before === null ? "create" : "replace";
    out.push({ path, op, before, after: cur });
  }
  return out;
}
