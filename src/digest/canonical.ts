// Canonical JSON and request digests (plan 03 §2).
//
// Rules: object keys sorted by Unicode code point, no whitespace, UTF-8, integers only,
// no `undefined`, no lone surrogates. Anything else throws: a digest that silently
// normalizes would let two different requests collide.

import { createHash } from "node:crypto";
import type { Digest, DigestOrAbsent } from "./file.ts";

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

function cmpCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = (x.value as string).codePointAt(0) as number;
    const cy = (y.value as string).codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError(`non-integer number: ${value}`);
      return String(value);
    case "string":
      if (!value.isWellFormed()) throw new CanonicalError("string with lone surrogate");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError("non-plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(cmpCodePoints);
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new CanonicalError(`undefined value at key ${JSON.stringify(k)}`);
        if (!k.isWellFormed()) throw new CanonicalError("key with lone surrogate");
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalError(`unsupported type: ${typeof value}`);
  }
}

export function digestOfJson(value: unknown): Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}` as Digest;
}

// ---- patch model (shared with edits.ts) -------------------------------------------------

export type Edit =
  | { op: "replace_exact"; path: string; old: string; new: string }
  | { op: "write_file"; path: string; content: string }
  | { op: "delete_file"; path: string };

export interface RequestBody {
  task_id: string;
  plan_revision: number;
  expected_files: { path: string; digest: DigestOrAbsent }[];
  edits: Edit[];
  declared_outputs: string[];
}

/**
 * Digest of an action request. Deliberately EXCLUDES run_id/action_id (they form the key) and
 * incarnation: a retry after a restart carries a new incarnation and must still be "the same
 * body under the same key" (index, decision 8).
 *
 * expected_files and declared_outputs are sets (sorted); edits are sorted by path with the
 * relative order of edits on the same path preserved, because that order is semantic.
 */
export function requestDigest(body: RequestBody): Digest {
  const byPath = (a: { path: string }, b: { path: string }) => cmpCodePoints(a.path, b.path);
  const edits = body.edits.map((e, i) => ({ e, i })).sort((x, y) => byPath(x.e, y.e) || x.i - y.i).map((x) => x.e);
  return digestOfJson({
    task_id: body.task_id,
    plan_revision: body.plan_revision,
    expected_files: [...body.expected_files].sort(byPath),
    edits,
    declared_outputs: [...body.declared_outputs].sort(cmpCodePoints),
  });
}

export { cmpCodePoints };
