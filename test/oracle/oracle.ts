// Plan 18 E8 (H8.1, H8.5): acceptance tests (the oracle) live in a directory the agent's sandbox hides. The host runs
// them against the workspace after the agent finishes, and every run is recorded, so repeated attempts are visible.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface OracleRun {
  passed: boolean;
  exitCode: number | null;
}

export function runOracle(opts: { oracleFile: string; workspace: string; attemptsDir: string; runId: string }): OracleRun {
  // The oracle runs as a fresh test process: the parent test runner's context must not leak into it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
  const r = spawnSync(process.execPath, ["--test", opts.oracleFile], { env: { ...env, ORACLE_WORKSPACE: opts.workspace }, encoding: "utf8" });
  const run = { passed: r.status === 0, exitCode: r.status };
  mkdirSync(opts.attemptsDir, { recursive: true });
  appendFileSync(join(opts.attemptsDir, "oracle-attempts.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), runId: opts.runId, passed: run.passed, exitCode: run.exitCode })}\n`);
  return run;
}
