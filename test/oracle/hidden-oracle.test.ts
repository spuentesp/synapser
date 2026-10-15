import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { bwrapAvailable, runSandboxed } from "../sandbox/harness.ts";
import { runOracle } from "./oracle.ts";

// Plan 18 E8 (H8.1, H8.5). The sandbox hides the oracle directory; the host runs the oracle and keeps a count.
const skip = bwrapAvailable() ? false : "bubblewrap is not installed";

describe("H8.1 the agent cannot read the oracle", { skip }, () => {
  const oracleDir = mkdtempSync(join(tmpdir(), "oracle-hidden-"));
  const workspace = mkdtempSync(join(tmpdir(), "oracle-ws-"));
  const oracleFile = join(oracleDir, "acceptance.test.mjs");
  writeFileSync(oracleFile, "// acceptance tests: the agent must not see this file\nconst ORACLE_MARKER = 'ORACLE-SECRET-CONTENT';\n");

  test("inside the sandbox, with the oracle directory hidden, the file cannot be read", () => {
    const r = runSandboxed({ workspace, hide: [oracleDir] }, ["/bin/sh", "-c", `cat ${oracleFile}`]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.includes("ORACLE-SECRET-CONTENT"), false);
  });

  test("the control: without hiding, the same read succeeds, so the refusal is the sandbox's doing", () => {
    const r = runSandboxed({ workspace }, ["/bin/sh", "-c", `cat ${oracleFile}`]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("ORACLE-SECRET-CONTENT"));
  });

  test("cleanup", () => {
    rmSync(oracleDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe("H8.5 every oracle run is counted", () => {
  test("a passing and a failing run each add one line to the attempts log", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-attempts-"));
    const workspace = mkdtempSync(join(tmpdir(), "oracle-ws2-"));
    const pass = join(dir, "pass.test.mjs");
    const fail = join(dir, "fail.test.mjs");
    writeFileSync(pass, "import assert from 'node:assert/strict'; assert.equal(1, 1);\n");
    writeFileSync(fail, "import assert from 'node:assert/strict'; assert.equal(1, 2);\n");
    const attempts = join(dir, "log");
    try {
      assert.equal(runOracle({ oracleFile: pass, workspace, attemptsDir: attempts, runId: "r1" }).passed, true);
      assert.equal(runOracle({ oracleFile: fail, workspace, attemptsDir: attempts, runId: "r1" }).passed, false);
      const lines = readFileSync(join(attempts, "oracle-attempts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { passed: boolean; runId: string });
      assert.deepEqual(lines.map((l) => l.passed), [true, false]);
      assert.ok(existsSync(join(attempts, "oracle-attempts.jsonl")));
    } finally {
      for (const d of [dir, workspace]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the oracle receives the workspace it must check, through ORACLE_WORKSPACE", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-env-"));
    const workspace = mkdtempSync(join(tmpdir(), "oracle-ws3-"));
    mkdirSync(join(dir, "log"));
    const probe = join(dir, "env.test.mjs");
    writeFileSync(probe, `import assert from 'node:assert/strict'; assert.equal(process.env.ORACLE_WORKSPACE, ${JSON.stringify(workspace)});\n`);
    try {
      assert.equal(runOracle({ oracleFile: probe, workspace, attemptsDir: join(dir, "log"), runId: "r2" }).passed, true);
    } finally {
      for (const d of [dir, workspace]) rmSync(d, { recursive: true, force: true });
    }
  });
});
