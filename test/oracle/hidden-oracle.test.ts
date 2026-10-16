import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

  test("the operational report exposes repeated attempts per run and rejects a corrupt log", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-report-"));
    const log = join(dir, "oracle-attempts.jsonl");
    const script = new URL("../../scripts/oracle-report.ts", import.meta.url).pathname;
    try {
      writeFileSync(log, [
        JSON.stringify({ at: "2026-10-15T12:00:00.000Z", runId: "r1", passed: false, exitCode: 1 }),
        JSON.stringify({ at: "2026-10-15T12:01:00.000Z", runId: "r1", passed: true, exitCode: 0 }),
        JSON.stringify({ at: "2026-10-15T12:02:00.000Z", runId: "r2", passed: true, exitCode: 0 }),
      ].join("\n") + "\n");
      const report = spawnSync(process.execPath, [script, log], { encoding: "utf8" });
      assert.equal(report.status, 0, report.stderr);
      assert.deepEqual(JSON.parse(report.stdout), {
        totalAttempts: 3,
        runs: [
          { runId: "r1", attempts: 2, passed: 1, failed: 1 },
          { runId: "r2", attempts: 1, passed: 1, failed: 0 },
        ],
        repeatedAttempts: 1,
      });

      writeFileSync(log, ["a", "b", "c"].map((runId) => JSON.stringify({
        at: "2026-10-15T12:03:00.000Z", runId, passed: false, exitCode: 1,
      })).join("\n") + "\n");
      const distinct = spawnSync(process.execPath, [script, log], { encoding: "utf8" });
      assert.equal(distinct.status, 0, distinct.stderr);
      assert.deepEqual(JSON.parse(distinct.stdout), {
        totalAttempts: 3,
        runs: [
          { runId: "a", attempts: 1, passed: 0, failed: 1 },
          { runId: "b", attempts: 1, passed: 0, failed: 1 },
          { runId: "c", attempts: 1, passed: 0, failed: 1 },
        ],
        repeatedAttempts: 0,
      }, "changing run ids must not hide the total count in the shared log");

      writeFileSync(log, "{broken json}\n");
      const corrupt = spawnSync(process.execPath, [script, log], { encoding: "utf8" });
      assert.notEqual(corrupt.status, 0);
      assert.match(corrupt.stderr, /invalid JSON on line 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
