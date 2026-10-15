import assert from "node:assert/strict";
import { appendFileSync, existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import { recoverRun } from "../../src/executor/recovery.ts";
import { NODE_WORKSPACE_DURABILITY } from "../../src/executor/fs-applier.ts";
import { fsyncDir } from "../../src/journal/artifacts.ts";
import { BASELINE, type Env, reopenEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { BILLING_AFTER, fresh, runChild } from "./support.ts";
import { copyWorkspaceSnapshot, restoreDurableWorkspace } from "./disk.ts";

// Power loss restores only workspace states acknowledged by the injected sync boundary. The
// executor, journal, Zoanthrope and recovery remain real; only durability at fsync is modeled.
const CASES = [
  { fault: "file:1", failpoint: "after-temp-written", expectedSync: "file:1:lost:" },
  { fault: "file:2", failpoint: "after-temp-written:2", expectedSync: "file:2:lost:" },
  { fault: "directory:1", failpoint: "after-first-rename", expectedSync: "directory:1:lost:" },
  { fault: "directory:2", failpoint: "between-renames", expectedSync: "directory:2:lost:" },
] as const;
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const listFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)))
    .sort();

describe("H11.2 simulated loss of unsynced workspace state recovers from the real journal", () => {
  const open: Env[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const e of open.splice(0)) await e.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  for (const seed of SEEDS) {
    const scenario = CASES[(seed - 1) % CASES.length]!;
    test(`seed ${seed}: ${scenario.fault} disappears at power loss and recovery rolls forward`, async () => {
      const { ws, state } = fresh();
      const modelRoot = mkdtempSync(join(tmpdir(), "synapser-durable-disk-"));
      roots.push(ws, state, modelRoot);
      const durableSnapshot = join(modelRoot, "workspace");
      const trace = join(modelRoot, "sync-trace.log");
      copyWorkspaceSnapshot(ws, durableSnapshot);

      const died = await runChild(state, ws, "two-files", scenario.failpoint, {
        SYNAPSER_DURABLE_SNAPSHOT: durableSnapshot,
        SYNAPSER_DISK_SYNC_FAULT: scenario.fault,
        SYNAPSER_DISK_SYNC_TRACE: trace,
      });
      assert.equal(died.signal, "SIGKILL", "the executor child must die at the selected crash point");
      assert.ok(died.actionId, "the child prepared a real journal action before crashing");
      const syncs = readFileSync(trace, "utf8");
      assert.match(syncs, new RegExp(scenario.expectedSync), "the intended sync was reached and selected as lost");

      const durableFiles = listFiles(durableSnapshot);
      const durableBilling = readFileSync(join(durableSnapshot, "app/billing.py"), "utf8");
      const billingWasCommittedFirst = scenario.fault === "file:2" || scenario.fault === "directory:2";
      const billingBefore = readFileSync(join(BASELINE, "app/billing.py"), "utf8");
      assert.equal(durableBilling, billingWasCommittedFirst ? BILLING_AFTER : billingBefore, "only prior durable renames survive");
      assert.equal(durableFiles.some((f) => f.includes(".synapser-tmp-")), false, "the unsynced directory entry may disappear even when the temp inode was synced");

      restoreDurableWorkspace(ws, durableSnapshot);
      const env = await reopenEnv(ws, state);
      open.push(env);
      const report = await recoverRun({
        executor: env.exec,
        journal: env.journal,
        zoo: env.zoo,
        workspaceRoot: env.ws,
        runId: RUN,
        generation: env.lock.generation,
      });
      const recoveryEvent = env.journal.listEvents().filter((e) => e.entity === "recovery").at(-1);
      assert.equal(report.degraded, false, JSON.stringify({ decisions: report.decisions, recovery: recoveryEvent?.data }).slice(0, 1200));
      assert.equal(env.journal.listNonTerminal().length, 0, "recovery settles the real journal action");
      assert.equal(env.read("app/billing.py"), BILLING_AFTER, "the complete intended file is restored");
      assert.match(env.read("app/schema.py"), /discount_bps: int = 0/, "the second intended file is restored");
      const billingRow = env.journal.getActionFiles(died.actionId!).find((f) => f.path === "app/billing.py");
      assert.ok(billingRow);
      assert.equal(statSync(join(ws, "app/billing.py")).mode & 0o777, billingRow.afterMode, "the intended file mode is restored");
      assert.deepEqual(listFiles(ws).filter((f) => f.includes(".synapser-tmp-")), [], "recovery removes all action temporaries");
      assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
    });
  }

  test("control: a completed directory sync survives the simulated power loss", async () => {
    const { ws, state } = fresh();
    const modelRoot = mkdtempSync(join(tmpdir(), "synapser-durable-control-"));
    roots.push(ws, state, modelRoot);
    const durableSnapshot = join(modelRoot, "workspace");
    const trace = join(modelRoot, "sync-trace.log");
    copyWorkspaceSnapshot(ws, durableSnapshot);
    appendFileSync(trace, "");
    const died = await runChild(state, ws, "two-files", "after-first-rename", {
      SYNAPSER_DURABLE_SNAPSHOT: durableSnapshot,
      SYNAPSER_DISK_SYNC_FAULT: "none",
      SYNAPSER_DISK_SYNC_TRACE: trace,
    });
    assert.equal(died.signal, "SIGKILL");
    assert.match(readFileSync(trace, "utf8"), /directory:1:durable:/);
    assert.equal(readFileSync(join(durableSnapshot, "app/billing.py"), "utf8"), BILLING_AFTER, "a synced rename is durable");
  });

  test("production durability delegates directly to file and directory fsync", () => {
    assert.equal(NODE_WORKSPACE_DURABILITY.syncFile, fsyncSync);
    assert.equal(NODE_WORKSPACE_DURABILITY.syncDirectory, fsyncDir);
  });
});
