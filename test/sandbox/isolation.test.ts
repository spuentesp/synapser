import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { bwrapAvailable, runSandboxed } from "./harness.ts";

// Plan 18 E6 (H6.1, H6.2, H6.4). Each test is an attack the sandbox must stop. Probes run only in throwaway folders.
const available = bwrapAvailable();
const skip = available ? false : "bubblewrap is not installed";

describe("H6.1 the sandbox keeps the agent inside its workspace", { skip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "sbx-outside-"));
  test("the workspace is writable", () => {
    const r = runSandboxed({ workspace: ws }, ["/bin/sh", "-c", `echo ok > ${ws}/inside.txt`]);
    assert.equal(r.status, 0, r.stderr);
  });
  test("a write outside the workspace is refused", () => {
    const r = runSandboxed({ workspace: ws }, ["/bin/sh", "-c", `echo x > ${outside}/escape.txt`]);
    assert.notEqual(r.status, 0);
  });
  test("the network is disconnected: an outbound connection fails", () => {
    const r = runSandboxed({ workspace: ws, timeoutMs: 10_000 }, ["node", "-e", "require('net').connect(80,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))"]);
    assert.equal(r.status, 3, `status ${r.status}`);
  });
  test("cleanup", () => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("H6.2 a credential placed where the sandbox hides it is not readable (K8 generalized)", { skip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "sbx-ws2-"));
  const home = mkdtempSync(join(tmpdir(), "sbx-home-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_test"), "SANDBOX-SENTINEL-KEY");
  test("a file under a hidden directory cannot be read by the agent", () => {
    const r = runSandboxed({ workspace: ws, hide: [join(home, ".ssh")] }, ["/bin/sh", "-c", `cat ${home}/.ssh/id_test`]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.includes("SANDBOX-SENTINEL-KEY"), false);
  });
  test("the same file is readable when it is not hidden (the control)", () => {
    const r = runSandboxed({ workspace: ws }, ["/bin/sh", "-c", `cat ${home}/.ssh/id_test`]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("SANDBOX-SENTINEL-KEY"));
  });
  test("cleanup", () => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("H6.4 a process that never ends is stopped at its time limit", { skip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "sbx-ws3-"));
  test("a loop is killed and reported as timed out", () => {
    const r = runSandboxed({ workspace: ws, timeoutMs: 2_000 }, ["/bin/sh", "-c", "while :; do :; done"]);
    assert.equal(r.timedOut, true);
  });
  test("cleanup", () => rmSync(ws, { recursive: true, force: true }));
});

describe("H6.4 the memory limit is inherited inside the sandbox", { skip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "sbx-resource-ws-"));
  test("an allocation beyond RLIMIT_AS fails inside the sandbox", () => {
    const r = runSandboxed({ workspace: ws, memoryLimitBytes: 96 * 1024 * 1024 }, [
      "python3", "-c",
      "try: bytearray(256*1024*1024)\nexcept MemoryError: print('memory-limit-hit'); raise SystemExit(42)\nraise SystemExit(0)",
    ]);
    assert.equal(r.status, 42, r.stderr);
    assert.match(r.stdout, /memory-limit-hit/);
  });

  test("cleanup", () => rmSync(ws, { recursive: true, force: true }));
});
