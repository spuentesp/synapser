// Local systemd integration proof for the shared per-run memory slice. No agent or model is invoked.
//   SYNAPSER_LIVE_RUN_MEMORY_SCOPE=1 node --test test/live/run-memory-scope.test.ts
// Invariant: two concurrent benign transient scopes can be assigned to one verified run slice.
// Verifier: systemd readback and cgroup paths show both child scopes below the same slice; teardown
// removes the child scopes and then the parent slice.
// Falsification: a child is outside the parent cgroup, configured memory properties differ, or any
// scope/cgroup remains after cleanup.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { RunMemoryScope } from "../../src/agents/run-memory-scope.ts";
import { boundedAgentArgv } from "../../src/agents/limits.ts";

const enabled = process.env["SYNAPSER_LIVE_RUN_MEMORY_SCOPE"] === "1";
const MEMORY_MAX_BYTES = 64 * 1024 * 1024;

function systemctl(args: string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `systemctl ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout);
}

function show(unit: string): Record<string, string> {
  return Object.fromEntries(systemctl([
    "show", unit, "--property=LoadState", "--property=ActiveState", "--property=ControlGroup",
    "--property=MemoryMax", "--property=MemoryAccounting",
  ]).trim().split("\n").map((line) => {
    const at = line.indexOf("=");
    return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)];
  }));
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    // systemd-run may report a non-zero status when the intentionally stopped sleep is terminated.
    child.once("close", () => resolve());
  });
}

async function waitForActive(unit: string): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = show(unit);
    if (state["ActiveState"] === "active" && state["ControlGroup"]) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${unit} did not become active`);
}

function isGone(unit: string): boolean {
  const state = show(unit);
  return state["LoadState"] === "not-found" || (state["ActiveState"] === "inactive" && state["ControlGroup"] === "");
}

function cgroupExists(controlGroup: string): boolean {
  try {
    readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.events`, "utf8");
    return true;
  } catch {
    return false;
  }
}

test("live RunMemoryScope groups concurrent transient scopes and cleans up", {
  skip: enabled ? false : "set SYNAPSER_LIVE_RUN_MEMORY_SCOPE=1 to use the real systemd user manager",
  timeout: 30_000,
}, async () => {
  assert.equal(process.platform, "linux", "this integration test requires Linux systemd user scopes");
  const run = new RunMemoryScope(MEMORY_MAX_BYTES);
  const childUnits = [0, 1].map(() => `synapser-agent-${randomUUID()}.scope`);
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  let runUnit: string | undefined;
  let parentControlGroup = "";

  try {
    runUnit = await run.ensure();
    const parent = show(runUnit);
    assert.equal(parent["LoadState"], "loaded");
    assert.equal(parent["ActiveState"], "active");
    assert.equal(Number(parent["MemoryMax"]), MEMORY_MAX_BYTES);
    assert.equal(parent["MemoryAccounting"], "yes");
    assert.ok(parent["ControlGroup"]);
    parentControlGroup = parent["ControlGroup"]!;
    assert.equal(readFileSync(`/sys/fs/cgroup${parentControlGroup}/memory.max`, "utf8").trim(), String(MEMORY_MAX_BYTES));

    for (const unit of childUnits) {
      const argv = boundedAgentArgv(["/usr/bin/sleep", "60"], unit, runUnit);
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
      children.push(child);
      exits.push(waitForExit(child));
    }

    const childStates = await Promise.all(childUnits.map(waitForActive));
    for (const state of childStates) {
      const childControlGroup = state["ControlGroup"]!;
      assert.ok(
        childControlGroup.startsWith(`${parentControlGroup}/`),
        `${childControlGroup} must be nested below ${parentControlGroup}`,
      );
    }
    assert.equal(show(runUnit)["ActiveState"], "active", "the shared parent remains active while children are running");

    await run.close();
    await Promise.all(exits);
    for (const unit of childUnits) assert.ok(isGone(unit), `${unit} should be inactive and released by parent teardown`);
    assert.ok(isGone(runUnit), `${runUnit} should be inactive and released`);
    assert.equal(cgroupExists(parentControlGroup), false, "the parent cgroup should be removed after close");
  } finally {
    // Best-effort teardown also runs when a membership/property assertion fails.
    for (const unit of childUnits) {
      try { systemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", unit]); } catch { /* already gone */ }
      try { systemctl(["stop", unit]); } catch { /* already gone */ }
    }
    await run.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.allSettled(exits);
  }
});
