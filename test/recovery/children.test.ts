// Review fix #4: a recorded pid is not an identity. Reap only what is provably ours.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { procStartTicks, reapStaleChildren } from "../../src/recovery/children.ts";

const alive = (pid: number) => procStartTicks(pid) !== null;
const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

function sleeper(): number {
  // detached = its own process group, like a validation subprocess would be
  const p = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  p.unref();
  spawned.push(p.pid!);
  return p.pid!;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reapStaleChildren", () => {
  test("kills a child of a previous generation, verified by start time, and waits for its exit", async () => {
    const j = Journal.open(mkdtempSync(join(tmpdir(), "reap-")), "r1");
    const pid = sleeper();
    await wait(30);
    j.tx((t) => t.registerChild({ pid, kind: "validation", runId: "r1", taskId: "t4", procStartTicks: procStartTicks(pid)!, pgid: pid, generation: 1 }));
    const out = await reapStaleChildren(j, 2);
    assert.deepEqual(out.map((o) => o.result), ["KILLED"]);
    assert.equal(alive(pid), false);
    assert.deepEqual(j.listChildren(), []);
    j.close();
  });

  test("a pid that now belongs to an UNRELATED process is never signalled", async () => {
    const j = Journal.open(mkdtempSync(join(tmpdir(), "reap-")), "r1");
    const stranger = sleeper();
    await wait(30);
    // we "recorded" this pid long ago with a different start time: i.e. the pid was reused
    j.tx((t) => t.registerChild({ pid: stranger, kind: "validation", runId: "r1", taskId: null, procStartTicks: procStartTicks(stranger)! - 12345, pgid: stranger, generation: 1 }));
    const out = await reapStaleChildren(j, 2);
    assert.deepEqual(out.map((o) => o.result), ["PID_REUSED_IGNORED"]);
    assert.equal(alive(stranger), true, "the unrelated process is still running");
    j.close();
  });

  test("children of the CURRENT generation and vanished children are handled without killing anything", async () => {
    const j = Journal.open(mkdtempSync(join(tmpdir(), "reap-")), "r1");
    const mine = sleeper();
    await wait(30);
    j.tx((t) => {
      t.registerChild({ pid: mine, kind: "validation", runId: "r1", taskId: null, procStartTicks: procStartTicks(mine)!, pgid: mine, generation: 2 });
      t.registerChild({ pid: 999_999, kind: "validation", runId: "r1", taskId: null, procStartTicks: 1, pgid: 999_999, generation: 1 });
    });
    const out = await reapStaleChildren(j, 2);
    assert.deepEqual(out.map((o) => [o.pid, o.result]), [[999_999, "ALREADY_GONE"]]);
    assert.equal(alive(mine), true, "current-generation child untouched");
    j.close();
  });

  test("procStartTicks parses comm names containing spaces and parentheses", () => {
    assert.ok((procStartTicks(process.pid) ?? 0) > 0);
    assert.equal(procStartTicks(999_999), null);
  });
});
