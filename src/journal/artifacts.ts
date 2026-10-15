// Content-addressed blob store (plan 01). A blob is durable BEFORE any journal row refers to it;
// an orphan blob is harmless, a dangling reference cannot happen.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Digest, isDigest, sha256Bytes } from "../digest/file.ts";
import { env } from "../sim/env.ts";

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write `bytes` to `finalPath` via a temp file in the same directory: fsync, rename, fsync dir. */
export function writeFileDurable(finalPath: string, bytes: Uint8Array, tmpName: string): void {
  const dir = dirname(finalPath);
  const tmp = join(dir, tmpName);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, finalPath);
  fsyncDir(dir);
}

export class ArtifactStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  #path(ref: Digest): string {
    const hex = ref.slice("sha256:".length);
    return join(this.root, "sha256", hex.slice(0, 2), hex.slice(2));
  }

  /** Store bytes; returns their digest, which is also the blob reference. Idempotent. */
  put(bytes: Uint8Array): Digest {
    const ref = sha256Bytes(bytes);
    const path = this.#path(ref);
    if (existsSync(path)) return ref;
    mkdirSync(dirname(path), { recursive: true });
    // unique temp so concurrent puts of the same content do not collide
    writeFileDurable(path, bytes, `.tmp-${process.pid}-${env.now()}-${env.random().toString(36).slice(2)}`);
    return ref;
  }

  has(ref: Digest): boolean {
    return existsSync(this.#path(ref));
  }

  /** Read and re-verify: a corrupted blob is an error, never silently used. */
  get(ref: string): Buffer {
    if (!isDigest(ref)) throw new Error(`invalid blob ref: ${ref}`);
    const bytes = readFileSync(this.#path(ref));
    if (sha256Bytes(bytes) !== ref) throw new Error(`artifact corrupted: ${ref}`);
    return bytes;
  }
}
