import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sha256Bytes } from "../../src/digest/file.ts";
import { ArtifactStore } from "../../src/journal/artifacts.ts";
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock, LockBusy } from "../../src/journal/lock.ts";

const CHILD = new URL("../fixtures/journal-child.ts", import.meta.url).pathname;
const run = (args: string[]): Promise<string> =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => res(out.trim()));
    p.on("error", rej);
  });
const hold = (stateDir: string, ws: string): Promise<{ p: ChildProcess; line: string }> =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [CHILD, "hold-lock", stateDir, ws], { stdio: ["pipe", "pipe", "inherit"] });
    p.stdout!.once("data", (d) => res({ p, line: String(d).trim() }));
    p.on("error", rej);
  });
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode ? r() : p.once("exit", () => r())));

describe("S17 workspace lock", () => {
  test("second executor is refused while the first lives; kill -9 releases it; generation grows", async () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const a = await hold(state, ws);
    assert.equal(a.line, "HELD generation=1");
    assert.match(await run(["try-lock", state, ws]), /^BUSY$/);
    assert.throws(() => acquireWorkspaceLock(state, ws), LockBusy); // in-process too
    a.p.kill("SIGKILL");
    await exited(a.p);
    const lock = acquireWorkspaceLock(state, ws);
    assert.equal(lock.generation, 2);
    lock.release();
    assert.equal(acquireWorkspaceLock(state, ws).generation, 3);
  });

  test("S17b: the lock is per workspace state root, not per run_id", async () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const a = await hold(state, ws);
    // a second mission (different run_id) on the same workspace goes through the same gate:
    // an executor must acquire the lock BEFORE it opens any run's journal.
    assert.throws(() => acquireWorkspaceLock(state, ws), LockBusy);
    a.p.kill("SIGKILL");
    await exited(a.p);
    const lock = acquireWorkspaceLock(state, ws);
    const j1 = Journal.open(state, "run-A");
    const j2 = Journal.open(state, "run-B");
    assert.notEqual(j1.dir, j2.dir);
    j1.close();
    j2.close();
    lock.release();
  });

  test("a state dir cannot be reused for a different workspace", () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    acquireWorkspaceLock(state, mkdtempSync(join(tmpdir(), "ws1-"))).release();
    assert.throws(() => acquireWorkspaceLock(state, mkdtempSync(join(tmpdir(), "ws2-"))), /belongs to workspace/);
  });
});

describe("cross-process CAS", () => {
  test("six processes race PREPARED→CLAIMING: exactly one wins, the rest see a conflict", async () => {
    const state = mkdtempSync(join(tmpdir(), "state-"));
    const j = Journal.open(state, "r1");
    const d = sha256Bytes(Buffer.from("x"));
    j.tx((t) =>
      t.insertAction({ runId: "r1", actionId: "a1", taskId: "t", actorOwner: "r1:t", incarnation: 1, planRevision: 1, requestDigest: d }, []),
    );
    j.close();
    const outs = await Promise.all(Array.from({ length: 6 }, () => run(["cas", state, "", "r1", "a1"])));
    assert.equal(outs.filter((o) => o === "WON").length, 1, outs.join(","));
    assert.equal(outs.filter((o) => o === "LOST TransitionConflict").length, 5, outs.join(","));
    const j2 = Journal.open(state, "r1");
    assert.equal(j2.getAction("a1")?.state, "CLAIMING");
    assert.equal(j2.listEvents().length, 2); // PREPARED + exactly one CLAIMING
    j2.close();
  });
});

describe("artifact store", () => {
  test("content-addressed, idempotent, verified on read, no temp leftovers", () => {
    const s = new ArtifactStore(join(mkdtempSync(join(tmpdir(), "art-")), "artifacts"));
    const ref = s.put(Buffer.from("hello"));
    assert.equal(ref, sha256Bytes(Buffer.from("hello")));
    assert.equal(s.put(Buffer.from("hello")), ref);
    assert.equal(s.get(ref).toString(), "hello");
    assert.equal(s.has(ref), true);
    const shard = join(s.root, "sha256", ref.slice(7, 9));
    assert.equal(readdirSync(shard).filter((n) => n.startsWith(".tmp-")).length, 0);
  });

  test("a corrupted blob is an error, never silently used", () => {
    const root = join(mkdtempSync(join(tmpdir(), "art-")), "artifacts");
    const s = new ArtifactStore(root);
    const ref = s.put(Buffer.from("hello"));
    const hex = ref.slice(7);
    writeFileSync(join(root, "sha256", hex.slice(0, 2), hex.slice(2)), "tampered");
    assert.throws(() => s.get(ref), /corrupted/);
    assert.throws(() => s.get("sha256:nothex"), /invalid blob ref/);
  });
});
