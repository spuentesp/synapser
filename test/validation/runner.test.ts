import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { type AllowedCommand, canIsolateNetwork, LocalRunner } from "../../src/validation/runner.ts";
import { takeSnapshot, treeDigest } from "../../src/validation/snapshot.ts";
import { BASELINE } from "../executor/env.ts";

const UNIT: AllowedCommand = { id: "unit", argv: ["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."] };
const py = (id: string, code: string, timeoutMs = 20_000): AllowedCommand => ({ id, argv: ["python3", "-c", code], timeoutMs });

describe("LocalRunner", () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));
  const setup = (commands: AllowedCommand[], over: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "val-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    const journal = Journal.open(realpathSync(mkdtempSync(join(tmpdir(), "val-state-"))), "r1");
    closers.push(() => journal.close());
    const runner = new LocalRunner({ journal, runId: "r1", workspaceRoot: ws, commands, generation: 1, ...over });
    return { ws, journal, runner };
  };

  test("passes on the baseline; evidence is bound to the snapshot digest and persisted", async () => {
    const { ws, journal, runner } = setup([UNIT]);
    const live = treeDigest(ws);
    const r = await runner.run("unit", { taskId: "validate" });
    assert.equal(r.passed, true);
    assert.equal(r.valid, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.snapshotDigest, live, "the digest is of exactly the tree that was tested");
    assert.equal(r.runner, "local");
    const [row] = journal.listValidations();
    assert.deepEqual([row?.command, row?.exitCode, row?.valid, row?.snapshotDigest], ["unit", 0, true, live]);
    assert.match(journal.artifacts.get(row!.outputBlob!).toString(), /"code":0/);
    assert.deepEqual(journal.listChildren(), [], "the child record is removed on exit");
  });

  test("S08: failing tests fail the validation, whatever any agent claimed", async () => {
    const { ws, runner } = setup([UNIT]);
    writeFileSync(join(ws, "tests", "test_basic.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1, 2)\n");
    const r = await runner.run("unit", { taskId: "validate" });
    assert.equal(r.passed, false);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /AssertionError|FAILED/);
  });

  test("commands outside the allowlist cannot run", async () => {
    const { runner } = setup([UNIT]);
    await assert.rejects(runner.run("rm-rf", { taskId: "x" }), /not in the allowlist/);
  });

  test("the snapshot carries no coordinator state, VCS data or executor temp files", async () => {
    const { ws, runner } = setup([
      py("clean", "import os,sys\nbad=[n for n in os.listdir('.')+os.listdir('app') if n in ('.zoanthrope','.synapser','.git') or n.startswith('.synapser-tmp-')]\nsys.exit(1 if bad else 0)"),
    ]);
    mkdirSync(join(ws, ".zoanthrope"));
    writeFileSync(join(ws, ".zoanthrope", "state.json"), "{}");
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, "app", ".synapser-tmp-act-1-0"), "x");
    const r = await runner.run("clean", { taskId: "v" });
    assert.equal(r.passed, true, r.stderr);
  });

  test("no network: the command runs in a private namespace (when the host supports it)", { skip: !canIsolateNetwork() && "host cannot unshare network namespaces" }, async () => {
    const { runner } = setup([
      py("offline", "import socket,sys\ntry:\n    socket.create_connection(('1.1.1.1',53),timeout=2); sys.exit(1)\nexcept OSError:\n    sys.exit(0)"),
    ]);
    const r = await runner.run("offline", { taskId: "v" });
    assert.equal(r.networkIsolated, true);
    assert.equal(r.passed, true, "the command could not reach the network");
  });

  test("S11: the workspace changing while the command runs invalidates the result", async () => {
    let ws2 = "";
    const { ws, runner } = setup([UNIT], {
      onSnapshot: () => writeFileSync(join(ws2, "app", "billing.py"), "# changed after the snapshot\n"),
    });
    ws2 = ws;
    const r = await runner.run("unit", { taskId: "v" });
    assert.equal(r.exitCode, 0, "the copy that was tested was fine…");
    assert.equal(r.valid, false, "…but it is no longer the tree that exists");
    assert.equal(r.passed, false);
    assert.match(r.note ?? "", /changed while/);
  });

  test("S18: a write racing the copy is detected and the copy retried", () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "snap-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    let raced = false;
    const snap = takeSnapshot(ws, mkdtempSync(join(tmpdir(), "snap-")), 3, {
      afterCopy: () => {
        if (!raced) {
          raced = true;
          writeFileSync(join(ws, "app", "billing.py"), "# written during the copy\n");
        }
      },
    });
    assert.equal(snap.consistent, true, "second attempt saw a quiet tree");
    assert.equal(snap.digest, treeDigest(ws));

    const always = takeSnapshot(ws, mkdtempSync(join(tmpdir(), "snap-")), 2, {
      afterCopy: () => writeFileSync(join(ws, "README.md"), `# ${Math.random()}\n`),
    });
    assert.equal(always.consistent, false, "a tree that never settles is reported, not trusted");
  });

  test("timeouts kill the whole process group and report TIMEOUT", async () => {
    const { runner, journal } = setup([py("slow", "import time\ntime.sleep(30)", 300)]);
    const t0 = Date.now();
    const r = await runner.run("slow", { taskId: "v" });
    assert.equal(r.timedOut, true);
    assert.equal(r.passed, false);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(journal.listChildren(), []);
  });

  test("while it runs, the child is registered with its start time so a dead executor's child can be reaped", async () => {
    const { runner, journal } = setup([py("nap", "import time\ntime.sleep(1.5)", 10_000)]);
    const running = runner.run("nap", { taskId: "v" });
    await new Promise((r) => setTimeout(r, 600));
    const kids = journal.listChildren();
    assert.equal(kids.length, 1);
    assert.equal(kids[0]?.kind, "validation");
    assert.ok(kids[0]!.procStartTicks > 0 && kids[0]!.pgid === kids[0]!.pid);
    await running;
  });
});
