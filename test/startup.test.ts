// The startup sequence as a whole: S17 (one executor), S09 (coordination down at boot),
// crash → restart → recovery, and reaping of children left by a dead generation.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { LockBusy } from "../src/journal/lock.ts";
import { procStartTicks } from "../src/recovery/children.ts";
import { startExecutor, type Started } from "../src/startup.ts";
import { loadPin } from "../src/zoo/pin.ts";
import { checkInvariants } from "./executor/invariants.ts";
import { BASELINE, RUN, T1 } from "./executor/env.ts";

const dirs = () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "start-ws-")));
  cpSync(BASELINE, ws, { recursive: true });
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "start-state-")));
  return { ws, stateDir };
};
const opts = (d: { ws: string; stateDir: string }, over: Partial<Parameters<typeof startExecutor>[0]> = {}) => ({
  stateDir: d.stateDir,
  workspace: d.ws,
  runId: RUN,
  pin: loadPin(),
  ...over,
});

describe("startExecutor", () => {
  const live: Started[] = [];
  const pids: number[] = [];
  afterEach(async () => {
    for (const s of live.splice(0)) await s.close();
    for (const p of pids.splice(0)) {
      try {
        process.kill(-p, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  const start = async (...a: Parameters<typeof startExecutor>) => {
    const s = await startExecutor(...a);
    live.push(s);
    return s;
  };

  test("clean boot: healthy, recovered, identity pinned, agent API open", async () => {
    const d = dirs();
    const s = await start(opts(d));
    assert.equal(s.degradedReason, null);
    assert.equal(s.report.degraded, false);
    assert.equal(s.executor.recovered, true);
    assert.equal(s.generation, 1);
    assert.equal(s.identity?.version, "0.1.3");
    assert.match(s.identity?.sha256 ?? "", /^[0-9a-f]{64}$/);
    const { incarnation } = s.executor.beginSession(T1);
    assert.equal((await s.executor.readFiles("t1", incarnation, ["README.md"])).kind, "ok");
  });

  test("S17: a second executor on the same workspace is refused and starts nothing", async () => {
    const d = dirs();
    await start(opts(d));
    await assert.rejects(startExecutor(opts(d, { runId: "another-run" })), LockBusy);
    // the refused attempt did not disturb the first one
    const mine = live[0]!;
    assert.equal(mine.executor.recovered, true);
  });

  test("S09: coordination engine missing at boot → degraded, API closed, nothing written", async () => {
    const d = dirs();
    const first = await start(opts(d));
    const before = first.journal.listEvents().length;
    await first.close();
    live.splice(0);

    const pin = { ...loadPin(), binary: "/nonexistent/zoanthrope" };
    const s = await start(opts(d, { pin }));
    assert.match(s.degradedReason ?? "", /SPAWN_FAILED/);
    assert.equal(s.report.degraded, true);
    assert.equal(s.executor.recovered, false);
    assert.equal(s.identity, null);
    const inc = s.executor.beginSession(T1).incarnation;
    assert.deepEqual(await s.executor.readFiles("t1", inc, ["README.md"]), { kind: "rejected", code: "RECOVERING" });
    // the journal is intact and still readable; only a DEGRADED marker was added
    assert.ok(s.journal.listEvents().length >= before);
    assert.ok(s.journal.listEvents().some((e) => e.entity === "recovery" && e.toState === "DEGRADED"));
  });

  test("a wrong pinned version is refused the same way (G0), not run", async () => {
    const d = dirs();
    const pin = { ...loadPin(), version: "9.9.9" };
    const s = await start(opts(d, { pin }));
    assert.match(s.degradedReason ?? "", /VERSION_MISMATCH/);
    assert.equal(s.executor.recovered, false);
  });

  test("crash → restart through the real entry point: recovered, generation grows, nothing lost", async () => {
    const d = dirs();
    // generation 1 dies mid-action: fire the failpoint in THIS process by throwing a crash marker
    class Crash extends Error {
      constructor() {
        super("simulated crash");
        this.name = "SimulatedCrash";
      }
    }
    const s1 = await start(
      opts(d, {
        failpoint: (name) => {
          if (name === "after-first-rename") throw new Crash();
        },
      }),
    );
    const inc = s1.executor.beginSession({ taskId: "t1", scope: ["app/billing.py", "app/schema.py"], planRevision: 1 }).incarnation;
    const read = await s1.executor.readFiles("t1", inc, ["app/billing.py", "app/schema.py"]);
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    const p = await s1.executor.proposePatch("t1", inc, read.viewId, [
      { op: "write_file", path: "app/billing.py", content: "# v2\n" },
      { op: "write_file", path: "app/schema.py", content: "# v2 schema\n" },
    ]);
    assert.equal(p.kind, "ok");
    if (p.kind !== "ok") return;
    await assert.rejects(s1.executor.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc }), /simulated crash/);
    // the "dead" generation: drop it without any cleanup, like a killed process would
    await s1.close();
    live.splice(0);

    const s2 = await start(opts(d));
    assert.equal(s2.generation, 2);
    assert.equal(s2.degradedReason, null);
    assert.equal(s2.executor.recovered, true);
    assert.equal(s2.report.decisions[0]?.decision, "ROLLED_FORWARD");
    assert.equal(s2.journal.getAction(p.actionId)?.state, "SETTLED");
    const ws = d.ws;
    assert.equal((await import("node:fs")).readFileSync(join(ws, "app/billing.py"), "utf8"), "# v2\n");
    assert.equal((await import("node:fs")).readFileSync(join(ws, "app/schema.py"), "utf8"), "# v2 schema\n");
    assert.deepEqual(s2.report.sessionsBumped, [`${RUN}:t1`]);
    // the old incarnation is dead; the same owner continues under the new one
    const next = s2.executor.beginSession(T1).incarnation;
    assert.equal(next, inc + 1);
    assert.deepEqual(await s2.executor.readFiles("t1", inc, ["README.md"]), { kind: "rejected", code: "STALE_INCARNATION" });
    assert.equal((await s2.executor.readFiles("t1", next, ["README.md"])).kind, "ok");
    assert.deepEqual(await checkInvariants({ journal: s2.journal, ws: d.ws, zoo: s2.zoo } as never, { expectNoClaims: true }), []);
  });

  test("a child left by the dead generation is killed (and an unrelated process is not)", async () => {
    const d = dirs();
    const s1 = await start(opts(d));
    const mk = () => {
      const p = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      p.unref();
      pids.push(p.pid!);
      return p.pid!;
    };
    const ours = mk();
    const stranger = mk();
    await new Promise((r) => setTimeout(r, 40));
    s1.journal.tx((t) => {
      t.registerChild({ pid: ours, kind: "validation", runId: RUN, taskId: "t4", procStartTicks: procStartTicks(ours)!, pgid: ours, generation: s1.generation });
      // recorded with a different start time: the pid "was reused" by an unrelated process
      t.registerChild({ pid: stranger, kind: "validation", runId: RUN, taskId: "t4", procStartTicks: procStartTicks(stranger)! - 999, pgid: stranger, generation: s1.generation });
    });
    await s1.close();
    live.splice(0);

    const s2 = await start(opts(d));
    const byPid = Object.fromEntries(s2.reaped.map((r) => [r.pid, r.result]));
    assert.equal(byPid[ours], "KILLED");
    assert.equal(byPid[stranger], "PID_REUSED_IGNORED");
    assert.equal(procStartTicks(ours), null);
    assert.notEqual(procStartTicks(stranger), null, "the unrelated process survives");
    assert.deepEqual(s2.journal.listChildren(), []);
  });
});
