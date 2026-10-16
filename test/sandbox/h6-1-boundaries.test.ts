import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { bwrapAvailable, runSandboxed } from "./harness.ts";

// H6.1 invariants: writes are confined to the workspace, a hidden ~/.ssh is unreadable,
// and neither host loopback nor an external address is reachable from the network namespace.
// Falsification: any successful escape/read/connect (or any request observed by the local fixture)
// fails a test. The only server is bound to host loopback; no external network is contacted.
const available = bwrapAvailable();
const workspace = mkdtempSync(join(tmpdir(), "h61-workspace-"));
const outside = mkdtempSync(join(tmpdir(), "h61-outside-"));
const home = mkdtempSync(join(tmpdir(), "h61-home-"));
const sshDir = join(home, ".ssh");
mkdirSync(sshDir);
writeFileSync(join(sshDir, "id_test"), "H61-SYNTHETIC-CREDENTIAL-SENTINEL");
let fixture: ReturnType<typeof createServer>;
let fixturePort = 0;
let fixtureConnections = 0;

before(async () => {
  fixture = createServer((socket) => {
    fixtureConnections += 1;
    socket.end("fixture\n");
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => {
      fixturePort = (fixture.address() as { port: number }).port;
      resolve();
    });
  });
});

after(() => {
  fixture?.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("H6.1 sandbox boundaries", { skip: available ? false : "bubblewrap is not installed" }, () => {
  test("workspace remains writable", () => {
    const target = join(workspace, "inside.txt");
    const result = runSandboxed({ workspace }, ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", target]);
    assert.equal(result.status, 0, result.stderr);
  });

  test("writes outside the workspace are refused", () => {
    const target = join(outside, "escape.txt");
    const result = runSandboxed({ workspace }, ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], 'escape')", target]);
    assert.notEqual(result.status, 0);
  });

  test("a synthetic credential under hidden ~/.ssh cannot be read", () => {
    const result = runSandboxed({ workspace, hide: [sshDir] }, ["node", "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", join(sshDir, "id_test")]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes("H61-SYNTHETIC-CREDENTIAL-SENTINEL"), false);
  });

  test("the host loopback fixture cannot be reached", () => {
    const beforeConnections = fixtureConnections;
    const script = "const s=require('node:net').connect(Number(process.argv[1]),'127.0.0.1');s.setTimeout(2500,()=>process.exit(43));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(42))";
    const result = runSandboxed({ workspace, timeoutMs: 5_000 }, ["node", "-e", script, String(fixturePort)]);
    assert.equal(result.status, 42, `expected refused/unroutable loopback, got ${result.status}: ${result.stderr}`);
    assert.equal(fixtureConnections, beforeConnections, "fixture observed a sandbox connection");
  });

  test("an external IP is unreachable without contacting an external service", () => {
    // TEST-NET-1 (192.0.2.1) is reserved for documentation; --unshare-net should fail before egress.
    const script = "const s=require('node:net').connect(80,'192.0.2.1');s.setTimeout(2500,()=>process.exit(43));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(42))";
    const result = runSandboxed({ workspace, timeoutMs: 5_000 }, ["node", "-e", script]);
    assert.equal(result.status, 42, `expected no route, got ${result.status}: ${result.stderr}`);
    assert.equal(fixtureConnections, 0, "only the separate local fixture is monitored; no service should be reached");
  });
});
