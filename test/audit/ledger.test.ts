// The audit ledger on a REAL recorded scenario: native + CLI agents on the real executor/zoanthrope.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";
import { verifyChain } from "../../src/audit/chain.ts";
import { coordination, costBy, exportLedger, orchestrationCost, timeline, verify, waste, whoChanged, why } from "../../src/audit/queries.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { buildScenario } from "./scenario.ts";

describe("hash-chained ledger + deterministic queries", () => {
  let env: Env;
  let nativeActionId = "";
  beforeEach(async () => {
    env = await makeEnv();
    nativeActionId = (await buildScenario(env)).nativeActionId;
  });
  afterEach(async () => env.close());

  test("the chain verifies, covers every event, and is stable across reopen", () => {
    const v = verify(env.journal);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.ok(v.events > 20);
    assert.equal(verifyChain(RUN, env.journal.eventChain()).head, v.head);
  });

  test("tampering is detected where it happened: edit, deletion, reorder-by-gap, and tail truncation", () => {
    const raw = env.journal.rawForTests;
    const chain = env.journal.eventChain();
    const headOk = verify(env.journal).head;

    // bypass the engine's own triggers, like someone editing the file would
    raw.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    raw.prepare("UPDATE events SET data_json = ? WHERE run_id = ? AND seq = 7").run('{"tampered":true}', RUN);
    let v = verify(env.journal);
    assert.deepEqual([v.ok, v.firstBadSeq], [false, 7]);
    assert.match(v.reason ?? "", /edited/);
    raw.prepare("UPDATE events SET data_json = ? WHERE run_id = ? AND seq = 7").run(chain[6]!.dataJson, RUN);
    assert.equal(verify(env.journal).ok, true, "restoring the text restores the chain");

    raw.prepare("DELETE FROM events WHERE run_id = ? AND seq = 9").run(RUN);
    v = verify(env.journal);
    // the chain reports the first event that no longer fits: the one AFTER the hole
    assert.deepEqual([v.ok, v.firstBadSeq], [false, 10]);
    assert.match(v.reason ?? "", /gap/);

    // a re-hashed forgery of the tail still fails against the ANCHORED head
    const last = chain.length;
    const j2 = verifyChain(RUN, chain.slice(0, last - 3), headOk);
    assert.equal(j2.ok, false);
    assert.match(j2.reason ?? "", /anchored head/);
  });

  test("an export verifies OFFLINE, and changing one field of it is caught", () => {
    const ex = JSON.parse(JSON.stringify(exportLedger(env.journal)));
    assert.equal(verifyChain(RUN, ex.events, ex.head).ok, true);
    ex.events[3].toState = "SOMETHING_ELSE";
    const v = verifyChain(RUN, ex.events, ex.head);
    assert.deepEqual([v.ok, v.firstBadSeq], [false, ex.events[3].seq]);
  });

  test("who-changed names the agent, adapter and digests of each applied change, in order", () => {
    const rows = whoChanged(env.journal, "app/schema.py");
    assert.equal(rows.length, 1, "the stale CLI change is NOT listed as having changed the file");
    assert.equal(rows[0]?.taskId, "t1");
    assert.equal(rows[0]?.agentRun?.adapter, "native");
    assert.equal(why(env.journal, rows[0]!.actionId).linkedBy, "window", "in-process runs are attributed by their own time window");
    assert.equal(rows[0]?.agentRun?.profile, "nemotron-worker");
    assert.notEqual(rows[0]?.beforeDigest, rows[0]?.afterDigest);
    const client = whoChanged(env.journal, "app/client.py");
    assert.equal(client.length, 1);
    assert.equal(client[0]?.agentRun?.profile, "cli-good", "a LATER run of the same task is never blamed");
    assert.equal(client[0]?.agentRun?.adapter, "cli-oneshot");
    assert.equal(why(env.journal, client[0]!.actionId).linkedBy, "integration", "CLI runs are attributed by the integration record");
  });

  test("why: the declared chain from mission to files, and the agent's own words labelled asserted", () => {
    const w = why(env.journal, nativeActionId);
    assert.equal(w.found, true);
    assert.equal(w.mission?.objective, "Add discount support");
    assert.equal(w.task?.id, "t1");
    assert.deepEqual(w.task?.criteria, ["t1 is done"]);
    assert.deepEqual(w.task?.context, ["shared contract"]);
    assert.deepEqual(w.action?.transitions.map((t) => t.to), ["PREPARED", "CLAIMING", "CLAIMED", "EXECUTING", "APPLIED", "RELEASE_PENDING", "SETTLED"]);
    assert.deepEqual(w.action?.files.map((f) => f.path), ["app/schema.py"]);
    assert.equal(w.agentRuns[0]?.adapter, "native");
    assert.deepEqual(w.asserted.map((a) => a.text), ["I appended a marker so the schema is documented"]);
    assert.equal(why(env.journal, "act-nope").found, false);
  });

  test("cost: unknown stays unknown (never 0), and the counts say how much of the total is known", () => {
    const by = Object.fromEntries(costBy(env.journal, "profile").map((r) => [r.key, r]));
    // native run used a scripted model that records no model_calls: its usage is UNKNOWN, not zero
    assert.equal(by["nemotron-worker"]?.tokensUnknownRuns, 1);
    assert.equal(by["nemotron-worker"]?.usdUnknownRuns, 1);
    // the CLI doubles report tokens (codex-style: 600 net input, 50 output) but no USD
    assert.equal(by["cli-good"]?.inputTokens, 600);
    assert.equal(by["cli-good"]?.outputTokens, 50);
    assert.equal(by["cli-good"]?.usdKnownRuns, 0);
    assert.equal(by["cli-good"]?.usdUnknownRuns, 1);
    assert.equal(by["cli-bad"]?.succeeded, 0);
    assert.deepEqual(orchestrationCost(env.journal), { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 });
    assert.deepEqual(costBy(env.journal, "adapter").map((r) => r.key), ["cli-oneshot", "native"]);
  });

  test("waste: failed and stale runs are listed with the reason; the ratio is computed from recorded tokens", () => {
    const w = waste(env.journal);
    const byProfile = Object.fromEntries(w.wastedRuns.map((r) => [r.profile, r.why]));
    assert.match(byProfile["cli-stale"] ?? "", /not integrated: STALE_VIEW/);
    assert.match(byProfile["cli-bad"] ?? "", /FAILED/);
    assert.equal("cli-good" in byProfile, false);
    assert.equal("nemotron-worker" in byProfile, false);
    assert.equal(w.totalRuns, 4);
    assert.ok(w.wasteRatio !== null && w.wasteRatio > 0 && w.wasteRatio < 1, `ratio ${String(w.wasteRatio)}`);
  });

  test("coordination: stale views are attributed to the task whose work was refused", () => {
    const rows = Object.fromEntries(coordination(env.journal).map((r) => [r.taskId, r]));
    assert.equal(rows["t2"]?.staleViews, 1);
    assert.equal(rows["t1"]?.staleViews, 0);
  });

  test("deterministic: the same ledger always answers the same, byte for byte", () => {
    const q = () => JSON.stringify([timeline(env.journal), whoChanged(env.journal, "app/schema.py"), why(env.journal, nativeActionId), costBy(env.journal, "profile"), waste(env.journal), coordination(env.journal)]);
    assert.equal(q(), q());
    const tl = timeline(env.journal, { taskId: "t2" });
    assert.ok(tl.length > 0 && tl.every((e, i) => i === 0 || e.seq > tl[i - 1]!.seq));
    assert.ok(tl.some((e) => /STALE_VIEW/.test(e.summary)));
  });

  test("the CLI prints the same answers (verify, why, cost) as JSON", () => {
    const run = (...a: string[]) => {
      const r = spawnSync(process.execPath, ["src/audit/cli.ts", "--state", env.state, "--run", RUN, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.equal(run("verify").ok, true);
    assert.equal(run("why", nativeActionId).task.id, "t1");
    assert.ok(run("cost", "--by", "adapter").by.length === 2);
    assert.equal(spawnSync(process.execPath, ["src/audit/cli.ts", "--state", env.state, "--run", RUN, "nonsense"], { encoding: "utf8" }).status, 2);
  });
});
