import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { importArtifact, materializePinnedArtifact, verifyMcpArtifact } from "../../src/mcp/artifact-store.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synapser-mcp-artifact-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const writable = (path: string): void => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports a deterministic sorted tree and normalizes only executable bits", () => {
  const base = tempRoot();
  const first = join(base, "source-a");
  const second = join(base, "source-b");
  mkdirSync(join(first, "nested"), { recursive: true });
  mkdirSync(join(second, "nested"), { recursive: true });
  writeFileSync(join(first, "nested", "run"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(first, "notes.txt"), "read me\n", { mode: 0o600 });
  writeFileSync(join(second, "notes.txt"), "read me\n", { mode: 0o644 });
  writeFileSync(join(second, "nested", "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const store = join(base, "store");
  const imported = importArtifact(first, store);
  const sameContent = importArtifact(second, store);
  assert.equal(imported.digest, sameContent.digest);
  assert.equal(verifyMcpArtifact(store, imported.digest), imported.path);
  assert.equal(lstatSync(join(imported.path, "nested", "run")).mode & 0o777, 0o555);
  assert.equal(lstatSync(join(imported.path, "notes.txt")).mode & 0o777, 0o444);
});

test("rejects a symlink instead of following it outside the source tree", () => {
  const base = tempRoot();
  const source = join(base, "source");
  mkdirSync(source);
  writeFileSync(join(base, "outside"), "not part of the import");
  symlinkSync(join(base, "outside"), join(source, "escape"));
  assert.throws(() => importArtifact(source, join(base, "store")), /symlink/);
});

test("rejects a Unix socket as a special file", async () => {
  const base = tempRoot();
  const source = join(base, "source");
  mkdirSync(source);
  const socketPath = join(source, "not-a-file");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.throws(() => importArtifact(source, join(base, "store")), /special file/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("materializes only a verified pin and detects tampering", () => {
  const base = tempRoot();
  const source = join(base, "source");
  mkdirSync(source);
  writeFileSync(join(source, "server.js"), "export {};\n");
  const store = join(base, "store");
  const imported = importArtifact(source, store);
  const destination = materializePinnedArtifact(store, imported.digest, join(base, "run", "server"));
  assert.equal(readFileSync(join(destination, "server.js"), "utf8"), "export {};\n");
  assert.throws(() => materializePinnedArtifact(store, imported.digest, destination), /EEXIST|not empty|exists/i);

  chmodSync(join(imported.path, "server.js"), 0o644);
  writeFileSync(join(imported.path, "server.js"), "changed\n");
  assert.throws(() => verifyMcpArtifact(store, imported.digest), /digest mismatch/);
  assert.throws(() => materializePinnedArtifact(store, imported.digest, join(base, "run", "tampered")), /digest mismatch/);
});

test("rejects malformed digest pins and a source root that is a symlink", () => {
  const base = tempRoot();
  const source = join(base, "source");
  mkdirSync(source);
  const store = join(base, "store");
  assert.throws(() => verifyMcpArtifact(store, "../latest"), /lowercase sha256 pin/);
  symlinkSync(source, join(base, "source-link"));
  assert.throws(() => importArtifact(join(base, "source-link"), store), /regular directory/);
});

test("rejects oversized package files before reading their contents", () => {
  const base = tempRoot();
  const source = join(base, "source");
  mkdirSync(source);
  const oversized = join(source, "large.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, 64 * 1024 * 1024 + 1);
  assert.throws(() => importArtifact(source, join(base, "store")), /exceeds the 67108864-byte import limit/);
});
