// Plan 10 §5 / W5: subtasks requested by agents. The broker is judged on what it REFUSES and on the
// plan being untouched by every refusal; the mission test proves an accepted subtask really runs.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkAcceptance, checkChain } from "../../src/audit/invariants.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import type { ProfileCard } from "../../src/orchestration/catalog.ts";
import { checkDelegation, DelegationBroker } from "../../src/orchestration/delegation.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, lastTool, ScriptedModel } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const card = (id: string, over: Partial<ProfileCard> = {}): ProfileCard => ({
  id, kinds: ["write"], integration: "pending", tier: "standard", pool: null, strengths: [], capabilities: { available: true, execution: "isolated-cli", output: "text", skills: "none", mcpClient: false, mcpConfigInjection: false, permissionModes: [], permissionMode: null, toolAllowlist: false, role: "writer", budgetFlag: false, budgetUsd: null, timeoutMs: 60_000, resume: false, steerable: null, capabilityIds: [] }, allowedSkillIds: [], cost: { basis: "unknown", reason: "NO_HISTORY" }, observed: null, enabled: true, ...over,
});

describe("DelegationBroker", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  /** A mission with one RUNNING task `api` (scope app/ + tests/), a PENDING acceptance node. */
  const seed = (over: { running?: boolean; gates?: string[] } = {}) => {
    const plan = { tasks: [{ id: "api", objective: "Implement the API", scope: ["app/", "tests/"], criteria: ["done"], context: [], deps: [], priority: 5 }] };
    env.journal.tx((t) => {
      t.insertMission({ runId: RUN, objective: "o", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
      t.insertPlanRevision(RUN, 1, plan, true);
      t.insertTask({ runId: RUN, taskId: "api", actorOwner: `${RUN}:api`, priority: 5, scope: ["app/", "tests/"], spec: { kind: "agent", objective: "Implement the API", criteria: ["done"], context: [], depth: 0, ...(over.gates ? { gates: over.gates } : {}) }, planRevision: 1, deps: [] });
      t.insertTask({ runId: RUN, taskId: "validate", actorOwner: `${RUN}:validate`, priority: -1, scope: [], spec: { kind: "validation", acceptance: [] }, planRevision: 1, deps: ["api"] });
      t.setMissionState(RUN, "DRAFT", "RUNNING");
    });
    if (over.running !== false) {
      env.journal.tx((t) => {
        t.setTaskState(RUN, "api", "PENDING", "READY", {});
        t.setTaskState(RUN, "api", "READY", "RUNNING", {});
      });
    }
  };
  const ask = (over: Record<string, unknown> = {}) => ({ objective: "Add unit tests for the API", scope: ["tests/test_api.py"], criteria: ["covers the happy path"], why: "tests are separate work", ...over });
  const broker = (cfg = {}, extra: Record<string, unknown> = {}) => new DelegationBroker({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, config: cfg, ...extra });
  const revisions = () => env.journal.listPlanRevisions().length;
  const refused = (r: ReturnType<DelegationBroker["request"]>, code: string) => {
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal((r as { code: string }).code, code, JSON.stringify(r));
  };

  test("accepted: an additive plan revision, a new task under acceptance, and both on the ledger", () => {
    seed();
    const b = broker();
    const r = b.request("api", ask());
    assert.ok(r.ok);
    assert.equal(r.revision, 2);
    assert.equal(r.depth, 1);
    const revs = env.journal.listPlanRevisions();
    assert.equal(revs.length, 2);
    const added = revs[1]!.plan.tasks.find((t: { id: string }) => t.id === r.taskId);
    assert.equal(added.requestedBy, "api");
    assert.equal(added.depth, 1);
    const task = env.journal.listTasks().find((t) => t.taskId === r.taskId)!;
    assert.equal(task.state, "PENDING");
    assert.deepEqual(task.scope, ["tests/test_api.py"]);
    assert.ok(env.journal.listTasks().find((t) => t.taskId === "validate")!.deps.includes(r.taskId), "acceptance waits for it");
    const ev = env.journal.listEvents().find((e) => e.entity === "delegation")!;
    assert.equal(ev.toState, "ACCEPTED");
    assert.equal((ev.data as { asserted_why: string }).asserted_why, "tests are separate work");
    assert.deepEqual(checkDelegation(env.journal), []);
  });

  test("every refusal has a code, is on the ledger, and leaves the plan exactly as it was", () => {
    seed();
    const small = broker({ maxDepth: 1, maxTasks: 3, maxPerTask: 2 });
    const before = JSON.stringify([env.journal.listPlanRevisions(), env.journal.listTasks()]);
    refused(small.request("ghost", ask()), "NOT_RUNNING");
    refused(small.request("api", ask({ scope: ["README.md"] })), "SCOPE_ESCAPE");
    refused(small.request("api", ask({ scope: ["../etc/passwd"] })), "SCOPE_ESCAPE");
    refused(small.request("api", ask({ kind: "deploy" })), "INVALID");
    assert.equal(JSON.stringify([env.journal.listPlanRevisions(), env.journal.listTasks()]), before, "refusals changed nothing");

    assert.ok(small.request("api", ask()).ok);
    refused(small.request("api", ask()), "DUPLICATE");
    assert.ok(small.request("api", ask({ objective: "Another tests task", scope: ["tests/test_more.py"] })).ok);
    refused(small.request("api", ask({ objective: "Third", scope: ["tests/t3.py"] })), "TOO_MANY_PER_TASK");
    assert.equal(revisions(), 3);
    const rej = env.journal.listEvents().filter((e) => e.entity === "delegation" && e.toState === "REJECTED").map((e) => (e.data as { code: string }).code);
    assert.deepEqual(rej, ["NOT_RUNNING", "SCOPE_ESCAPE", "SCOPE_ESCAPE", "INVALID", "DUPLICATE", "TOO_MANY_PER_TASK"]);
  });

  test("depth is configurable: a child may not delegate past maxDepth", () => {
    seed();
    const b1 = broker({ maxDepth: 1 });
    const child = b1.request("api", ask());
    assert.ok(child.ok);
    // make the child RUNNING and let it try to delegate
    env.journal.tx((t) => {
      t.setTaskState(RUN, child.taskId, "PENDING", "READY", {});
      t.setTaskState(RUN, child.taskId, "READY", "RUNNING", {});
    });
    refused(b1.request(child.taskId, ask({ objective: "grandchild task", scope: ["tests/test_api.py"] })), "TOO_DEEP");
    const b2 = broker({ maxDepth: 2 });
    const gc = b2.request(child.taskId, ask({ objective: "grandchild task", scope: ["tests/test_api.py"] }));
    assert.ok(gc.ok && gc.depth === 2);
    assert.deepEqual(checkDelegation(env.journal), []);
  });

  test("the plan size is capped: the Nth task beyond maxTasks is refused", () => {
    seed();
    const b = broker({ maxTasks: 2, maxPerTask: 5 });
    assert.ok(b.request("api", ask()).ok);
    const r = b.request("api", ask({ objective: "One more task please", scope: ["tests/other.py"] }));
    refused(r, "TOO_MANY_TASKS");
    assert.equal(revisions(), 2);
  });

  test("TOO_LATE once acceptance has started", () => {
    seed();
    env.journal.tx((t) => {
      t.setTaskState(RUN, "validate", "PENDING", "READY", {});
      t.setTaskState(RUN, "validate", "READY", "RUNNING", {});
    });
    refused(broker().request("api", ask()), "TOO_LATE");
  });

  test("a delegated step is validated like any plan: unknown profile and budget are refused", () => {
    seed();
    const catalog = [card("good", { cost: { basis: "estimated", usdPerRun: 0.1, low: 0.1, high: 0.2, n: 5 } })];
    refused(broker({}, { catalog }).request("api", ask({ profile: "ghost" })), "INVALID");
    const r = broker({}, { catalog, budgetUsd: 0.1 }).request("api", ask());
    refused(r, "INVALID");
    assert.match((r as { detail: string }).detail, /OVER_BUDGET/);
    assert.ok(broker({}, { catalog, budgetUsd: 5 }).request("api", ask({ profile: "good" })).ok);
  });

  test("a gated requester cannot launder work through a subtask: the child inherits the gate", () => {
    seed({ gates: ["approval"] });
    const r = broker().request("api", ask());
    assert.ok(r.ok);
    const child = env.journal.listTasks().find((t) => t.taskId === r.taskId)!;
    assert.deepEqual(child.spec.gates, ["approval"]);
    const stored = env.journal.listPlanRevisions()[1]!.plan.tasks.find((t: { id: string }) => t.id === r.taskId);
    assert.deepEqual(stored.gates, ["approval"]);
  });

  test("W5 checker flags: a non-additive revision, a task with no requester, and a scope escape", () => {
    seed();
    assert.deepEqual(checkDelegation(env.journal), []);
    const rev1 = env.journal.listPlanRevisions()[0]!.plan;
    // rewrite an existing task and add an orphan: both are violations
    env.journal.tx((t) =>
      t.insertPlanRevision(
        RUN,
        2,
        { tasks: [{ ...rev1.tasks[0], objective: "changed under our feet" }, { id: "orphan", objective: "no requester", scope: ["x"], criteria: ["c"], deps: [] }, { id: "esc", objective: "escapes", scope: ["README.md"], criteria: ["c"], deps: [], requestedBy: "api", depth: 1 }] },
        true,
      ),
    );
    const codes = checkDelegation(env.journal).map((v) => `${v.where}:${v.code}`).sort();
    assert.deepEqual(codes, ["api:REVISION_NOT_ADDITIVE", "esc:NO_DELEGATION_EVENT", "esc:SCOPE_ESCAPE", "orphan:ADDED_WITHOUT_REQUESTER"]);
  });
});

describe("mission with delegation", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const validation = () =>
    new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }], generation: env.lock.generation });
  const plan: Plan = { tasks: [{ id: "api", objective: "Implement the discount API and arrange its tests", scope: ["app/schema.py", "tests/"], criteria: ["api done"], deps: [] }] };

  /** One scripted brain for every task: the parent asks for a subtask; the child writes its file. */
  const brain = (opts: { askTwiceDeeper?: boolean } = {}) =>
    new ScriptedModel((messages) => {
      const first = messages.find((m) => m.role === "user")!.content!;
      const isChild = /Write the discount tests/.test(first);
      const last = lastTool(messages);
      if (isChild) {
        if (last === null) return { calls: [call("read_files", { paths: ["tests/test_discount.py"] })] };
        if (last.files) {
          const calls = [call("write_file", { path: "tests/test_discount.py", content: "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n" }), call("apply_changes", {})];
          return { calls };
        }
        if (opts.askTwiceDeeper && last.status === "SETTLED") {
          return { calls: [call("request_subtask", { objective: "Grandchild beyond the limit", scope: ["tests/test_discount.py"], criteria: ["c"], why: "deeper" })] };
        }
        return { calls: [call("finish", { summary: "tests written" })] };
      }
      if (last === null) return { calls: [call("request_subtask", { objective: "Write the discount tests", scope: ["tests/test_discount.py"], criteria: ["a unittest file exists"], why: "tests are separate from the API" })] };
      if (last.status === "ACCEPTED") return { calls: [call("finish", { summary: "api done; tests requested" })] };
      return { calls: [call("finish", { summary: `unexpected: ${JSON.stringify(last).slice(0, 120)}` })] };
    });

  const go = (model: ScriptedModel, cfg = { maxDepth: 2 }) =>
    runMission(
      { executor: env.exec, journal: env.journal, model, validation: validation(), delegation: cfg },
      { runId: RUN, objective: "o", plan, acceptance: ["imports"], limits: { concurrency: 3, maxRepairRounds: 0, missionMs: 60_000 } },
    );

  test("the requested subtask RUNS as its own task, acceptance waits for it, and every invariant holds", async () => {
    const r = await go(brain());
    assert.equal(r.status, "DONE", r.reason ?? "");
    const ids = env.journal.listTasks().map((t) => t.taskId);
    assert.ok(ids.includes("api-s1"));
    assert.equal(env.journal.listTasks().find((t) => t.taskId === "api-s1")!.state, "DONE");
    assert.match(env.read("tests/test_discount.py"), /unittest/);
    assert.deepEqual(checkDelegation(env.journal), []);
    assert.deepEqual(checkAcceptance(env.journal), []);
    assert.deepEqual(checkChain(env.journal), []);
    assert.equal(env.journal.listPlanRevisions().length, 2);
  });

  test("a delegation past the depth limit is REFUSED to the agent, which keeps working; the mission still completes", async () => {
    const r = await go(brain({ askTwiceDeeper: true }), { maxDepth: 1 });
    assert.equal(r.status, "DONE", r.reason ?? "");
    const rej = env.journal.listEvents().filter((e) => e.entity === "delegation" && e.toState === "REJECTED");
    assert.equal(rej.length >= 1, true);
    assert.equal((rej[0]!.data as { code: string }).code, "TOO_DEEP");
    assert.equal(env.journal.listTasks().some((t) => t.taskId.includes("s1-s1")), false);
    assert.deepEqual(checkDelegation(env.journal), []);
  });

  test("without delegation configured the tool is not offered and a call is refused as DISABLED", async () => {
    const model = brain();
    const r = await runMission(
      { executor: env.exec, journal: env.journal, model, validation: validation() },
      { runId: RUN, objective: "o", plan, acceptance: ["imports"], limits: { maxRepairRounds: 0, missionMs: 60_000 } },
    );
    assert.equal(model.requests.every((x) => x.hasTools), true);
    assert.equal(env.journal.listTasks().some((t) => t.taskId === "api-s1"), false);
    assert.match(JSON.stringify(model.seen.at(-1)), /DISABLED/);
    void r;
  });
});
