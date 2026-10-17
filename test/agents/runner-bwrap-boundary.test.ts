import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runAgent } from "../../src/agents/runner.ts";
import { Journal } from "../../src/journal/journal.ts";

const CLI = `
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { return { error: error.code || error.message }; } };
let outsideWrite;
try { writeFileSync(process.env.SYNAPSER_TEST_OUTSIDE_WRITE_FILE, 'OUTSIDE-WRITE-SENTINEL'); outsideWrite = true; }
catch (error) { outsideWrite = { error: error.code || error.message }; }
const hostPid = process.env.SYNAPSER_TEST_HOST_PID;
let pidVisible = null;
let pidNamespace = null;
if (hostPid) {
  pidVisible = existsSync('/proc/' + hostPid);
  try { pidNamespace = readlinkSync('/proc/self/ns/pid'); } catch {}
}
let detachedCommand = null;
if (process.env.SYNAPSER_TEST_DETACHED_COMMAND) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.env.SYNAPSER_TEST_DETACHED_COMMAND], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 100));
  detachedCommand = process.env.SYNAPSER_TEST_DETACHED_COMMAND;
}
const result = {
  home: process.env.HOME,
  homeFile: read(process.env.SYNAPSER_TEST_HOME_FILE),
  simulatedRunFile: read(process.env.SYNAPSER_TEST_RUN_FILE),
  outsideWrite,
  pidVisible,
  pidNamespace,
  detachedCommand,
};
writeFileSync('.boundary-probe.json', JSON.stringify(result));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'boundary-probe' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'probe', type: 'agent_message', text: 'boundary probe complete' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;

interface BoundaryResult {
  home: string;
  homeFile: string | { error: string };
  simulatedRunFile: string | { error: string };
  outsideWrite: boolean | { error: string };
  pidVisible: boolean | null;
  pidNamespace: string | null;
  detachedCommand?: string | null;
}

async function probeBoundary(withHostPid = false, detachedCommand?: string): Promise<{ report: BoundaryResult; outsideWriteExists: boolean; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "runner-bwrap-boundary-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const operatorHome = join(root, "operator-home");
  const simulatedRun = join(root, "run-simulation");
  const bin = join(root, "bin");
  for (const directory of [workspace, state, operatorHome, simulatedRun, bin]) mkdirSync(directory, { recursive: true });

  const homeSentinel = join(operatorHome, "host-home-sentinel.txt");
  const runSentinel = join(simulatedRun, "host-run-sentinel.txt");
  const outsideWrite = join(root, "outside-work-sentinel.txt");
  writeFileSync(homeSentinel, "HOME-HOST-SENTINEL");
  writeFileSync(runSentinel, "RUN-HOST-SENTINEL");
  const cli = join(bin, "boundary-probe.mjs");
  writeFileSync(cli, CLI);

  let host: ReturnType<typeof spawn> | undefined;
  const sentinel = `runner-host-fixture-${process.pid}-${Date.now()}`;
  try {
    let hostPid: number | undefined;
    if (withHostPid) {
      host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { PATH: process.env["PATH"] ?? "", SYNAPSER_RUNNER_TEST_SENTINEL: sentinel },
        stdio: "ignore",
      });
      assert.ok(host.pid, "same-UID host fixture has a PID");
      hostPid = host.pid;
      const hostEnv = readFileSync(`/proc/${hostPid}/environ`, "utf8").split("\0");
      assert.ok(hostEnv.includes(`SYNAPSER_RUNNER_TEST_SENTINEL=${sentinel}`), "only the controlled sentinel is inspected");
    }

    const journal = Journal.open(state, "runner-bwrap-boundary");
    try {
      const profile = {
        id: "boundary-probe", description: "A local CLI fixture for filesystem boundary checks", role: "writer" as const,
        argv: [process.execPath, cli], parser: "codex-jsonl" as const, timeoutMs: 15_000, tags: ["test"], enabled: true,
        env: {
          SYNAPSER_TEST_HOME_FILE: homeSentinel,
          SYNAPSER_TEST_RUN_FILE: runSentinel,
          SYNAPSER_TEST_OUTSIDE_WRITE_FILE: outsideWrite,
          ...(hostPid === undefined ? {} : { SYNAPSER_TEST_HOST_PID: String(hostPid) }),
          ...(detachedCommand === undefined ? {} : { SYNAPSER_TEST_DETACHED_COMMAND: detachedCommand }),
        },
      };
      const result = await runAgent({
        profile, prompt: "probe filesystem boundary", workspaceRoot: workspace, runId: "runner-bwrap-boundary",
        taskId: null, journal, generation: 1,
        envSource: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, HOME: operatorHome },
      });
      assert.equal(result.outcome, "SUCCEEDED", result.reason ?? "fixture CLI must report its structured success event");
      const probe = result.changes.find((change) => change.path === ".boundary-probe.json");
      assert.ok(probe?.afterBlob, "the probe report must be returned from the work copy");
      const report = JSON.parse(journal.artifacts.get(probe.afterBlob).toString("utf8")) as BoundaryResult;
      return { report, outsideWriteExists: existsSync(outsideWrite), root };
    } finally {
      journal.close();
    }
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
    if (host) await new Promise<void>((resolve) => {
      if (host!.exitCode !== null || host!.signalCode !== null) return resolve();
      host!.once("exit", () => resolve());
      setTimeout(() => resolve(), 1_000).unref();
    });
  }
}

test("runAgent still gives its CLI a scratch HOME derived from envSource", async () => {
  const { report, root } = await probeBoundary();
  try {
    assert.match(report.home, /synapser-agent-.*\/home$/, "the CLI HOME itself remains the runner's scratch HOME");
    assert.notEqual(report.home, join(root, "operator-home"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAgent CLI cannot read an absolute sentinel under the operator HOME", async () => {
  const { report, root } = await probeBoundary();
  try {
    assert.notEqual(report.homeFile, "HOME-HOST-SENTINEL", JSON.stringify(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAgent CLI cannot read an absolute sentinel under a portable /run simulation", async () => {
  const { report, root } = await probeBoundary();
  try {
    assert.notEqual(report.simulatedRunFile, "RUN-HOST-SENTINEL", JSON.stringify(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAgent CLI cannot write to an absolute path outside its work copy", async () => {
  const { report, outsideWriteExists, root } = await probeBoundary();
  try {
    assert.notEqual(report.outsideWrite, true, "the CLI must not write via an absolute host path outside cwd/work");
    assert.equal(outsideWriteExists, false, "the external write target remains untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAgent hides same-UID host PIDs when it launches in a private PID namespace", async (t) => {
  const { report, root } = await probeBoundary(true);
  try {
    const hostPidNamespace = readlinkSync("/proc/self/ns/pid");
    if (report.pidNamespace === hostPidNamespace) t.skip("runAgent currently uses the host PID namespace; isolation check applies once a private PID namespace is enabled");
    assert.equal(report.pidVisible, false, "the same-UID host process PID must not exist in the runner's PID namespace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAgent removes a detached descendant from the transient systemd scope before returning", async () => {
  const sentinel = `runner-detached-${process.pid}-${Date.now()}`;
  const { report, root } = await probeBoundary(false, sentinel);
  try {
    assert.equal(report.detachedCommand, sentinel, "the CLI started the controlled descendant fixture");
    const hostProcesses = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    assert.equal(hostProcesses.includes(sentinel), false, "no detached process from the completed scope remains on the host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
