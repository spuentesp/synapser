// Day 19: a REAL executor process is SIGKILLed at each failpoint; a new process recovers.
// Scenario: one action over two files (app/billing.py, app/schema.py) — the S05 shape.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { recoverRun } from "../../src/executor/recovery.ts";
import type { ZooPort } from "../../src/executor/executor.ts";
import { type Env, propose, reopenEnv, RUN, T1 } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { wp } from "../helpers.ts";
import { BILLING_AFTER, fresh, runChild } from "./support.ts";


describe("S05 and friends: kill the executor at every failpoint, recover with a new process", () => {
  const open: Env[] = [];
  afterEach(async () => {
    for (const e of open.splice(0)) await e.close();
  });

  const MATRIX: { fp: string; scenario?: string; expect: string; claimsHeldAfterCrash: boolean }[] = [
    { fp: "after-prepare-commit", expect: "UNTOUCHED", claimsHeldAfterCrash: false },
    { fp: "after-claim-intent", expect: "CLAIMING_NO_CLAIMS_RETRY", claimsHeldAfterCrash: false },
    { fp: "after-zoo-grant", expect: "CLAIMING_FULL_SET_CONTINUED", claimsHeldAfterCrash: true },
    { fp: "after-claimed-commit", expect: "CLAIMED_CONTINUED", claimsHeldAfterCrash: true },
    { fp: "after-executing-commit", expect: "ROLLED_FORWARD", claimsHeldAfterCrash: true },
    { fp: "after-temp-written", expect: "ROLLED_FORWARD", claimsHeldAfterCrash: true },
    { fp: "after-first-rename", expect: "ROLLED_FORWARD", claimsHeldAfterCrash: true },
    { fp: "between-renames", expect: "ALL_AFTER_CONFIRMED", claimsHeldAfterCrash: true },
    { fp: "after-last-rename", expect: "ALL_AFTER_CONFIRMED", claimsHeldAfterCrash: true },
    { fp: "after-applied-before-reply", expect: "APPLIED_RELEASED", claimsHeldAfterCrash: true },
    { fp: "after-release-pending", expect: "RELEASE_COMPLETED", claimsHeldAfterCrash: true },
    { fp: "after-zoo-release", expect: "RELEASE_COMPLETED", claimsHeldAfterCrash: false },
    { fp: "after-stale-view", scenario: "stale", expect: "STALE_VIEW_RELEASED", claimsHeldAfterCrash: true },
  ];

  for (const m of MATRIX) {
    test(`${m.fp}: process dies, recovery decides ${m.expect}`, async () => {
      const { ws, state } = fresh();
      const died = await runChild(state, ws, m.scenario ?? "two-files", m.fp);
      assert.equal(died.signal, "SIGKILL", `the child must die at the failpoint (code=${died.code})`);

      const env = await reopenEnv(ws, state);
      open.push(env);
      // The journal, not the dead process's stdout, is the source of truth for what exists.
      const pending = env.journal.listNonTerminal();
      assert.equal(pending.length, 1, "exactly one action was left behind");
      const actionId = pending[0]!.actionId;

      // What the crash left behind in the shared registry (claims persist across the process).
      const claims = (await env.zoo.listClaims()).filter((c) => c.agent.startsWith(`${RUN}:`));
      assert.equal(claims.length > 0, m.claimsHeldAfterCrash, `claims after crash: ${JSON.stringify(claims.map((c) => c.path))}`);

      const report = await recoverRun({
        executor: env.exec,
        journal: env.journal,
        zoo: env.zoo,
        workspaceRoot: env.ws,
        runId: RUN,
        generation: env.lock.generation,
      });
      assert.equal(report.degraded, false);
      const decision = report.decisions.find((d) => d.actionId === actionId);
      assert.equal(decision?.decision, m.expect);

      const a = env.journal.getAction(actionId)!;
      if (m.fp === "after-prepare-commit" || m.fp === "after-claim-intent") {
        // nothing was written; the agent retries and the action completes normally
        assert.equal(env.read("app/billing.py").includes("v2"), false);
        const inc = env.journal.getSessionIncarnation(`${RUN}:t1`)!;
        const r = await env.exec.applyAction({ actionId: a.actionId, requestDigest: a.requestDigest, incarnation: inc });
        assert.equal(r.status, "SETTLED");
      }

      const final = env.journal.getAction(actionId)!;
      if (m.scenario === "stale") {
        assert.equal(final.state, "SETTLED");
        assert.equal(final.errorCode, "STALE_VIEW");
        assert.equal(env.read("app/billing.py"), "# edited out of band\n", "foreign content is preserved");
        assert.equal(env.read("app/schema.py").includes("discount_bps"), false);
      } else {
        assert.equal(final.state, "SETTLED", `final state was ${final.state}`);
        assert.equal(env.read("app/billing.py"), BILLING_AFTER);
        assert.match(env.read("app/schema.py"), /discount_bps: int = 0/);
      }

      assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
      assert.deepEqual((await env.zoo.listClaims()).filter((c) => c.agent.startsWith(`${RUN}:`)), []);
    });
  }

  test("S05 in detail: after the first rename only one file is AFTER, and recovery finishes ONLY the other", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename");
    assert.equal(died.signal, "SIGKILL");
    // evidence of the partial state, before any recovery runs
    assert.equal(readFileSync(join(ws, "app/billing.py"), "utf8"), BILLING_AFTER);
    assert.equal(readFileSync(join(ws, "app/schema.py"), "utf8").includes("discount_bps"), false);

    const env = await reopenEnv(ws, state);
    open.push(env);
    // while the crash is unreconciled, a competitor cannot have the files (no TTL shortcut)
    const rival = await env.zoo.claim("rival", wp("app/schema.py"), "edit");
    assert.equal(rival.kind, "conflict");

    const before = env.journal.getActionFiles(died.actionId!);
    assert.deepEqual(before.map((f) => f.progress), ["PENDING", "PENDING"], "the journal never recorded the first rename");
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.decisions[0]?.decision, "ROLLED_FORWARD");
    assert.deepEqual(report.decisions[0]?.detail, { classes: [["app/billing.py", "AFTER"], ["app/schema.py", "BEFORE"]] });

    const events = env.journal.listEvents().filter((e) => e.entity === "action" && e.entityId === died.actionId);
    assert.equal(events.filter((e) => e.toState === "APPLIED").length, 1);
    assert.equal(events.filter((e) => e.toState === "EXECUTING").length, 1, "never re-entered EXECUTING from scratch");
    assert.equal((await env.zoo.claim("rival", wp("app/schema.py"), "edit")).kind, "granted", "released after settling");
  });

  test("recovery never overwrites content it did not predict: RECOVERY_REQUIRED, bytes preserved, dependents blocked", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename");
    assert.equal(died.signal, "SIGKILL");
    // someone edits the not-yet-applied file while the executor is dead
    writeFileSync(join(ws, "app/schema.py"), "# somebody else was here\n");

    const env = await reopenEnv(ws, state);
    open.push(env);
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.decisions[0]?.decision, "OBSERVED_FOREIGN_CONTENT");

    assert.equal(env.journal.getAction(died.actionId!)?.state, "RECOVERY_REQUIRED");
    assert.equal(env.read("app/schema.py"), "# somebody else was here\n", "foreign bytes untouched");
    assert.equal(env.read("app/billing.py"), BILLING_AFTER, "already-applied file is not rolled back");
    const ev = env.journal.listEvents().find((e) => e.toState === "RECOVERY_REQUIRED") as { data: { evidence: { path: string; blob: string }[] } };
    assert.equal(ev.data.evidence[0]?.path, "app/schema.py");
    assert.equal(env.journal.artifacts.get(ev.data.evidence[0]!.blob).toString(), "# somebody else was here\n");

    // the files are blocked for new work until a human reconciles
    assert.deepEqual([...env.journal.blockedPaths().keys()].sort(), ["app/billing.py", "app/schema.py"]);
    // and the claims are still ours (nobody may take them by waiting)
    assert.equal((await env.zoo.claim("rival", wp("app/schema.py"), "edit")).kind, "conflict");
    // running recovery again changes nothing
    const again = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(again.decisions[0]?.decision, "STILL_FOREIGN_CONTENT");
    assert.equal(env.read("app/schema.py"), "# somebody else was here\n");
    assert.deepEqual(await checkInvariants(env), []);
  });

  test("review #1: bytes that change WHILE recovery re-acquires the claim are never overwritten", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename");
    assert.equal(died.signal, "SIGKILL");
    let port!: ZooPort;
    const env = await reopenEnv(ws, state, {
      zoo: (real) =>
        (port = {
          // the foreign write lands between classification and the grant
          claim: async (agent, files, intent, o) => {
            if (o?.purpose?.startsWith("recovery")) writeFileSync(join(ws, "app/schema.py"), "# foreign, during the claim\n");
            return real.claim(agent, files, intent, o);
          },
          release: (...a) => real.release(...a),
          listClaims: (a) => real.listClaims(a),
          rejoin: (a) => real.rejoin(a),
        }),
    });
    open.push(env);
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: port, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.decisions[0]?.decision, "OBSERVED_FOREIGN_CONTENT");
    assert.equal(env.journal.getAction(report.decisions[0]!.actionId)?.state, "RECOVERY_REQUIRED");
    assert.equal(env.read("app/schema.py"), "# foreign, during the claim\n", "foreign bytes intact");
    assert.equal(env.read("app/billing.py"), BILLING_AFTER, "the applied file is not rolled back");
  });

  test("plan 04 'mix with progress up to date': 3 files, file 1 APPLIED+recorded, file 2 AFTER unrecorded, file 3 BEFORE", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "three-files", "between-renames:1");
    assert.equal(died.signal, "SIGKILL");
    assert.equal(readFileSync(join(ws, "app/client.py"), "utf8"), '"""client v2"""\n', "file 2 landed");
    assert.equal(readFileSync(join(ws, "app/schema.py"), "utf8").includes("discount_bps"), false, "file 3 did not");

    const env = await reopenEnv(ws, state);
    open.push(env);
    const id = env.journal.listNonTerminal()[0]!.actionId;
    assert.deepEqual(env.journal.getActionFiles(id).map((f) => [f.path, f.progress]), [
      ["app/billing.py", "APPLIED"],
      ["app/client.py", "PENDING"],
      ["app/schema.py", "PENDING"],
    ]);
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.decisions[0]?.decision, "ROLLED_FORWARD");
    assert.deepEqual(report.decisions[0]?.detail, {
      classes: [["app/billing.py", "AFTER"], ["app/client.py", "AFTER"], ["app/schema.py", "BEFORE"]],
    });
    assert.deepEqual(env.journal.getActionFiles(id).map((f) => f.progress), ["APPLIED", "APPLIED", "APPLIED"]);
    assert.equal(env.journal.getAction(id)?.state, "SETTLED");
    assert.match(env.read("app/schema.py"), /discount_bps/);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });

  test("G3: downtime LONGER than the presence and lease TTLs does not open the files to a rival", async () => {
    const TTL = { ZOANTHROPE_TTL_SECS: "1", ZOANTHROPE_LEASE_TTL_SECS: "1" };
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename", TTL);
    assert.equal(died.signal, "SIGKILL");
    await new Promise((r) => setTimeout(r, 2500)); // well past both TTLs

    const env = await reopenEnv(ws, state, { env: TTL });
    open.push(env);
    const rival = await env.zoo.claim("rival", wp("app/schema.py"), "edit");
    assert.equal(rival.kind, "conflict", "expiry alone grants nothing");
    if (rival.kind === "conflict") {
      assert.equal(rival.conflict.holderStale, true, "the holder is stale — and still blocks");
      assert.equal(rival.conflict.holder, `${RUN}:t1`);
    }
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.decisions[0]?.decision, "ROLLED_FORWARD");
    assert.deepEqual(report.claimsAtRisk, []);
    assert.equal(env.journal.getAction(report.decisions[0]!.actionId)?.state, "SETTLED");
    assert.equal((await env.zoo.claim("rival", wp("app/schema.py"), "edit")).kind, "granted");
  });

  test("review #4: a stray claim on a path with only a PREPARED proposal is an orphan, not 'covered'", async () => {
    const { ws, state } = fresh();
    const env = await reopenEnv(ws, state);
    open.push(env);
    const { incarnation } = env.exec.beginSession(T1);
    await propose(env, T1, incarnation, ["app/billing.py"], [{ op: "write_file", path: "app/billing.py", content: "x\n" }]);
    assert.equal(env.journal.listNonTerminal()[0]?.state, "PREPARED");
    await env.zoo.claim(`${RUN}:t1`, wp("app/billing.py"), "edit"); // stray: PREPARED holds no claim
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.deepEqual(report.orphanClaimsReleased, [{ agent: `${RUN}:t1`, path: "app/billing.py" }]);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });

  test("review #5: nothing is accepted until recovery has reported", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename");
    assert.equal(died.signal, "SIGKILL");
    const env = await reopenEnv(ws, state, { requireRecovery: true });
    open.push(env);
    const inc = env.exec.beginSession(T1).incarnation;
    assert.equal(env.exec.recovered, false);
    assert.deepEqual(await env.exec.readFiles("t1", inc, ["README.md"]), { kind: "rejected", code: "RECOVERING" });
    const p = env.journal.listNonTerminal()[0]!;
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc });
    assert.equal(r.error_code, "RECOVERING");

    await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(env.exec.recovered, true);
    const incNow = env.journal.getSessionIncarnation(`${RUN}:t1`)!;
    assert.equal((await env.exec.readFiles("t1", incNow, ["README.md"])).kind, "ok");
    // and the incarnation the old process held no longer works
    assert.deepEqual(await env.exec.readFiles("t1", inc, ["README.md"]), { kind: "rejected", code: "STALE_INCARNATION" });
  });

  test("the invariant checker really detects violations (mutation test)", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", null);
    assert.equal(died.receipt?.status, "SETTLED");
    const env = await reopenEnv(ws, state);
    open.push(env);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), [], "clean run has no violations");

    // I1: a lost update — an applied result was clobbered after the fact
    writeFileSync(join(ws, "app/billing.py"), "# clobbered\n");
    assert.match((await checkInvariants(env))[0] ?? "", /^I1:/);
    writeFileSync(join(ws, "app/billing.py"), BILLING_AFTER);

    // I5: a leftover temp file
    writeFileSync(join(ws, "app", ".synapser-tmp-act-t1-1-0"), "x");
    assert.match((await checkInvariants(env)).join("\n"), /I5:/);

    // I3: a claim of ours that no live action explains
    await env.zoo.claim(`${RUN}:t1`, wp("README.md"), "edit");
    assert.match((await checkInvariants(env, { expectNoClaims: true })).join("\n"), /I3:/);

    // I6: a hole in the event sequence (simulated by checking a journal whose events we cannot edit:
    // the trigger refuses, which is the point — the database itself blocks this corruption)
    assert.throws(() => env.journal.rawForTests.exec("DELETE FROM events WHERE seq=2"), /append-only/);
  });

  test("a clean run needs no recovery, and recovery is idempotent", async () => {
    const { ws, state } = fresh();
    const done = await runChild(state, ws, "two-files", null);
    assert.equal(done.code, 0);
    assert.equal(done.receipt?.status, "SETTLED");
    const env = await reopenEnv(ws, state);
    open.push(env);
    const events = env.journal.listEvents().length;
    const r1 = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.deepEqual(r1.decisions, []);
    assert.deepEqual(r1.orphanClaimsReleased, []);
    // only the RECOVERY_REPORT (and the session bump of the new generation) are new
    const added = env.journal.listEvents().slice(events).map((e) => `${e.entity}:${e.toState}`);
    assert.deepEqual(added.sort(), ["recovery:REPORT", "session:ACTIVE"].sort());
    assert.equal(env.read("app/billing.py"), BILLING_AFTER);
  });

  test("orphan read claims of our own run are released; foreign agents are never touched", async () => {
    const { ws, state } = fresh();
    const env = await reopenEnv(ws, state);
    open.push(env);
    await env.zoo.claim(`${RUN}:t1#r`, wp("README.md"), "read"); // a read_files that died mid-call
    await env.zoo.claim("someone-elses-agent", wp("app/client.py"), "edit");
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.deepEqual(report.orphanClaimsReleased, [{ agent: `${RUN}:t1#r`, path: "README.md" }]);
    const left = (await env.zoo.listClaims()).map((c) => `${c.agent}:${c.path}`);
    assert.deepEqual(left, ["someone-elses-agent:app/client.py"]);
  });

  test("S09 at startup: coordination unavailable → classify and report, write nothing", async () => {
    const { ws, state } = fresh();
    const died = await runChild(state, ws, "two-files", "after-first-rename");
    assert.equal(died.signal, "SIGKILL");
    const env = await reopenEnv(ws, state);
    open.push(env);
    const schemaBefore = env.read("app/schema.py");
    const report = await recoverRun({ executor: env.exec, journal: env.journal, zoo: downZoo(), workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation });
    assert.equal(report.degraded, true);
    assert.equal(report.decisions[0]?.decision, "DEFERRED_COORDINATION_UNAVAILABLE");
    assert.equal(env.read("app/schema.py"), schemaBefore, "nothing was written while degraded");
    assert.equal(env.journal.getAction(died.actionId!)?.state, "EXECUTING");
  });
});

function downZoo() {
  return {
    claim: async () => {
      throw new Error("must not claim while degraded");
    },
    release: async () => {
      throw new Error("must not release while degraded");
    },
    rejoin: async () => {
      throw new Error("must not rejoin while degraded");
    },
    listClaims: async () => {
      const { ZooError } = await import("../../src/zoo/types.ts");
      throw new ZooError("TRANSPORT_CLOSED", "zoanthrope is down");
    },
  };
}
