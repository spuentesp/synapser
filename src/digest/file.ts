// File identity (plan 03 §1). One module computes every content hash in the product.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type Digest = `sha256:${string}`;

/** JSON/text spelling of "the file does not exist". Never confused with the empty-file hash. */
export const ABSENT = "absent" as const;
export type DigestOrAbsent = Digest | typeof ABSENT;

export const MAX_ACTION_FILE_BYTES = 1024 * 1024;

export function sha256Bytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

export function isDigest(v: unknown): v is Digest {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
}

export type Observation =
  | { kind: "absent" }
  | { kind: "file"; digest: Digest; mode: number; size: number }
  /** Directory, symlink, device… or unreadable: never classified as BEFORE/AFTER. */
  | { kind: "other"; reason: "NOT_REGULAR" | "SYMLINK" | "UNREADABLE"; detail?: string };

/**
 * Observe `absPath` as it is on disk right now. Streams the file, so there is no size cap here:
 * recovery must be able to classify a file that grew past the action limit.
 * Does not follow symlinks (a symlink is `other`).
 */
export function observeFile(absPath: string): Observation {
  let st;
  try {
    st = lstatSync(absPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "other", reason: "UNREADABLE", detail: String(e) };
  }
  if (st.isSymbolicLink()) return { kind: "other", reason: "SYMLINK" };
  if (!st.isFile()) return { kind: "other", reason: "NOT_REGULAR" };
  let fd: number | undefined;
  try {
    // O_NOFOLLOW is implicit in the lstat above; a race that swaps in a symlink would still be
    // caught by the post-open fstat identity check below.
    fd = openSync(absPath, "r");
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
      return { kind: "other", reason: "NOT_REGULAR", detail: "changed during observation" };
    }
    const h = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
    return { kind: "file", digest: `sha256:${h.digest("hex")}` as Digest, mode: st.mode & 0o7777, size };
  } catch (e) {
    return { kind: "other", reason: "UNREADABLE", detail: String(e) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Digest of an observation for comparison with journal values; `null` for non-comparable. */
export function comparable(o: Observation): DigestOrAbsent | null {
  if (o.kind === "absent") return ABSENT;
  if (o.kind === "file") return o.digest;
  return null;
}
