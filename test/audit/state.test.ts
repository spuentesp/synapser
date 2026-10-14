// Plan 11: live state as a pure function of the ledger (L1, L2) and the Zoanthrope-facing
// invariants Z3 (intent before write) and Z4 (no silent orphan claims).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CliOneShotRunner, NativeLoopRunner } from "../../src/agents/adapters.ts";
import { AgentRunnerRegistry } from "../../src/agents/port.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { costBy } from "../../src/audit/queries.ts";
import { swarmState } from "../../src/audit/state.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import { buildCatalog } from "../../src/orchestration/catalog.ts";
import { checkIntentBeforeWrite, checkNoSilentOrphans } from "../../src/orchestration/invariants.ts";
import { ZooCollector } from "../../src/zoo/collector.ts";
import { zooIntentSink } from "../../src/zoo/intent.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "./scenario.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const SCHEMA = "app/schema.py";

describe("swarm state", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  test("L1: an agent WAITING on another is visible at the instant it happens, and replayable by seq afterwards", async () => {
    const a = env.exec.beginSession({ taskId: "ta", scope: [SCHEMA], planRevision: 1 });
    const b = env.exec.beginSession({ taskId: "tb", scope: [SCHEMA], planRevision: 1 });
    const read = async (task: string, inc: number) => {
      const r = await env.exec.readFiles(task, inc, [SCHEMA]);
      assert.equal(r.kind, "ok");
      return (r as Extract<typeof r, { kind: "ok" }>).viewId;
    };
    const va = await read("ta", a.incarnation);
    const vb = await read("tb", b.incarnation);
    const text = env.read(SCHEMA);
    const pa = await env.exec.proposePatch("ta", a.incarnation, va, [{ op: "replace_exact", path: SCHEMA, old: text.slice(0, 20), new: `${text.slice(0, 20)}# A\n` }]);
    const pb = await env.exec.proposePatch("tb", b.incarnation, vb, [{ op: "replace_exact", path: SCHEMA, old: text.slice(0, 20), new: `${text.slice(0, 20)}# B\n` }]);
    assert.ok(pa.kind === "ok" && pb.kind === "ok");

    const hold = env.gate("after-claimed-commit", pa.actionId);
    const applyA = env.exec.applyAction({ actionId: pa.actionId, requestDigest: pa.requestDigest, incarnation: a.incarnation });
    await hold.reached;
    const w = await env.exec.applyAction({ actionId: pb.actionId, requestDigest: pb.requestDigest, incarnation: b.incarnation }, { maxAttempts: 1, backoffMs: 1 });
    assert.equal(w.status, "WAITING_RESOURCE");
    const seqWhileWaiting = env.journal.listEvents().at(-1)!.seq;
    const liveJson = JSON.stringify(swarmState(env.journal));

    const live = swarmState(env.journal);
    const A = live.agents.find((x) => x.taskId === "ta")!;
    const B = live.agents.find((x) => x.taskId === "tb")!;
    assert.equal(A.currentAction?.state, "CLAIMED");
    assert.deepEqual(A.heldFiles, [SCHEMA]);
    assert.equal(B.status, "waiting");
    assert.deepEqual({ holder: B.waitingOn!.holder, path: B.waitingOn!.path }, { holder: `${RUN}:ta`, path: SCHEMA });

    hold.open();
    await applyA;
    // the past is reproducible: state at that seq is byte-identical to what we saw live
    assert.equal(JSON.stringify(swarmState(env.journal, seqWhileWaiting)), liveJson);
    const after = swarmState(env.journal);
    assert.equal(after.agents.find((x) => x.taskId === "ta")!.currentAction, null);
    assert.deepEqual(after.agents.find((x) => x.taskId === "ta")!.heldFiles, []);
    // and it is deterministic
    assert.equal(JSON.stringify(swarmState(env.journal)), JSON.stringify(swarmState(env.journal)));
  });
});

describe("orchestrated mission with intents, observation and state", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }, { ...cli("w-client", "edit-client"), tags: ["client"] }];
  const T = (id: string, scope: string[], tags: string[]) => ({ id, objective: `Do ${id} work`, scope, criteria: [`${id} done`], deps: [], tags });

  const runIt = async (collector?: ZooCollector) => {
    const model = new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] }));
    const plan: Plan = { tasks: [T("schema", [SCHEMA], ["schema"]), T("client", ["app/client.py"], ["client"])] };
    return runMission(
      {
        executor: env.exec,
        journal: env.journal,
        model,
        intent: zooIntentSink(env.zoo),
        ...(collector ? { collector } : {}),
        validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }], generation: env.lock.generation }),
        orchestration: {
          catalog: buildCatalog(PROFILES, [], { knownUsdPerRun: { "w-schema": 0.01, "w-client": 0.01 } }),
          profiles: PROFILES,
          registry: new AgentRunnerRegistry([new NativeLoopRunner(model), new CliOneShotRunner()]),
          executor: env.exec,
          workspaceRoot: env.ws,
          generation: env.lock.generation,
        },
      },
      { runId: RUN, objective: "o", plan, acceptance: ["imports"], limits: { maxRepairRounds: 0, missionMs: 60_000 } },
    );
  };

  test("Z3 holds, the collector sees the run's own claims and posts, Z4 finds no orphan, and L2 matches the cost query", async () => {
    const r = await runIt();
    assert.equal(r.status, "DONE", r.reason ?? "");

    assert.deepEqual(checkIntentBeforeWrite(env.journal), []);
    const intents = env.journal.listEvents().filter((e) => e.entity === "intent");
    assert.deepEqual(intents.map((e) => `${e.entityId}:${e.toState}`).sort(), ["client:POSTED", "schema:POSTED"]);

    const col = new ZooCollector({ source: env.zoo, journal: env.journal, runId: RUN });
    const d = await col.drain();
    assert.equal(d.gap, false);
    const seen = env.journal.listEvents().filter((e) => e.entity === "zoo_observation").map((e) => e.data as { agent: string; action: string });
    assert.ok(seen.some((o) => o.agent === `${RUN}:schema` && o.action === "post"), "the declared intention is observable");
    assert.ok(seen.some((o) => o.agent === `${RUN}:schema` && o.action === "claim"));

    assert.deepEqual(checkNoSilentOrphans(env.journal, await env.zoo.listClaims()), []);

    // L2: per-task totals in the state equal the cost query (same data, two views)
    const st = swarmState(env.journal);
    for (const row of costBy(env.journal, "task")) {
      const a = st.agents.find((x) => x.taskId === row.key)!;
      assert.equal(a.runs.n, row.runs, row.key);
      assert.equal(a.runs.inputTokens, row.inputTokens, row.key);
      assert.equal(a.runs.outputTokens, row.outputTokens, row.key);
      assert.equal(a.runs.usdUnknownRuns, row.usdUnknownRuns, row.key);
    }
    assert.ok(st.zoo.observations > 0);
    assert.deepEqual(st.agents.filter((a) => a.taskId !== "validate").map((a) => a.status), ["done", "done"]);
  });

  test("Z3 flags a write with no declared intention, and one declared too late; Z4 flags a claim nobody can account for", async () => {
    env.journal.tx((t) => {
      t.event(RUN, "intent_policy", RUN, null, "ENABLED", {});
      t.event(RUN, "action", "act-a-1", null, "PREPARED", { task_id: "a", files: ["x"] });
      t.event(RUN, "action", "act-a-1", "CLAIMED", "EXECUTING", {});
      t.event(RUN, "action", "act-b-1", null, "PREPARED", { task_id: "b", files: ["y"] });
      t.event(RUN, "action", "act-b-1", "CLAIMED", "EXECUTING", {});
      t.event(RUN, "intent", "b", null, "POSTED", { actor: `${RUN}:b`, post_id: "p" });
      t.event(RUN, "action", "act-c-1", null, "PREPARED", { task_id: "c", files: ["z"] });
      t.event(RUN, "intent", "c", null, "FAILED", { actor: `${RUN}:c`, error: "zoo down" }); // announced (failed) BEFORE writing is fine
      t.event(RUN, "action", "act-c-1", "CLAIMED", "EXECUTING", {});
    });
    assert.deepEqual(checkIntentBeforeWrite(env.journal).map((v) => `${v.where}:${v.code}`).sort(), ["a:NO_INTENT", "b:INTENT_AFTER_WRITE"]);

    await env.zoo.claim(`${RUN}:ghost`, [SCHEMA as never], "edit", { purpose: "nobody owns this" });
    const orphans = checkNoSilentOrphans(env.journal, await env.zoo.listClaims());
    assert.deepEqual(orphans.map((v) => v.code), ["ORPHAN_CLAIM"]);
    assert.equal(orphans[0]!.where, SCHEMA);
  });
});

describe("collector wired into the scheduler", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  test("a mission with a collector ends with the run's claims and posts on the ledger, and a failing source cannot fail the mission", async () => {
    const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
    const model = new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] }));
    const mk = (collector: ZooCollector) =>
      runMission(
        {
          executor: env.exec, journal: env.journal, model, collector, intent: zooIntentSink(env.zoo),
          validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema"], timeoutMs: 20_000 }], generation: env.lock.generation }),
          orchestration: {
            catalog: buildCatalog(PROFILES, [], { knownUsdPerRun: { "w-schema": 0.01 } }), profiles: PROFILES,
            registry: new AgentRunnerRegistry([new NativeLoopRunner(model), new CliOneShotRunner()]),
            executor: env.exec, workspaceRoot: env.ws, generation: env.lock.generation,
          },
        },
        { runId: RUN, objective: "o", plan: { tasks: [{ id: "schema", objective: "Do schema work", scope: [SCHEMA], criteria: ["c"], deps: [], tags: ["schema"] }] }, acceptance: ["imports"], limits: { maxRepairRounds: 0, missionMs: 60_000 } },
      );
    const r = await mk(new ZooCollector({ source: env.zoo, journal: env.journal, runId: RUN }));
    assert.equal(r.status, "DONE", r.reason ?? "");
    const obs = env.journal.listEvents().filter((e) => e.entity === "zoo_observation").map((e) => (e.data as { action: string }).action);
    assert.ok(obs.includes("post") && obs.includes("claim") && obs.includes("release"), obs.join(","));
    assert.equal(swarmState(env.journal).zoo.gaps, 0);
  });

  test("an unreachable audit source is recorded and the mission still completes", async () => {
    const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
    const model = new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] }));
    const broken = new ZooCollector({ source: { auditLog: async () => { throw new Error("zoo is down"); } }, journal: env.journal, runId: RUN });
    const r = await runMission(
      {
        executor: env.exec, journal: env.journal, model, collector: broken,
        validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema"], timeoutMs: 20_000 }], generation: env.lock.generation }),
        orchestration: {
          catalog: buildCatalog(PROFILES, [], { knownUsdPerRun: { "w-schema": 0.01 } }), profiles: PROFILES,
          registry: new AgentRunnerRegistry([new NativeLoopRunner(model), new CliOneShotRunner()]),
          executor: env.exec, workspaceRoot: env.ws, generation: env.lock.generation,
        },
      },
      { runId: RUN, objective: "o", plan: { tasks: [{ id: "schema", objective: "Do schema work", scope: [SCHEMA], criteria: ["c"], deps: [], tags: ["schema"] }] }, acceptance: ["imports"], limits: { maxRepairRounds: 0, missionMs: 60_000 } },
    );
    assert.equal(r.status, "DONE", r.reason ?? "");
    const errs = env.journal.listEvents().filter((e) => e.entity === "zoo_gap" && e.toState === "ERROR");
    assert.ok(errs.length >= 1);
    assert.match(String((errs[0]!.data as { error: string }).error), /zoo is down/);
  });
});
