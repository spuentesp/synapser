import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { validatePlan } from "../../src/mission/plan.ts";
import { planMission, PlanError } from "../../src/mission/supervisor.ts";
import { BILLING_CONTRACT, billingPlan } from "../../src/mission/billing-fixture.ts";
import { ScriptedModel } from "../agent/scripted.ts";
import { BASELINE } from "../executor/env.ts";

const ws = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "plan-ws-")));
  cpSync(BASELINE, d, { recursive: true });
  return d;
};
const task = (over: Record<string, unknown> = {}) => ({ id: "a", objective: "Do the first thing well", scope: ["app/billing.py"], criteria: ["it works"], deps: [], ...over });

describe("validatePlan", () => {
  const root = ws();
  const errs = (raw: unknown) => {
    const r = validatePlan(raw, { workspaceRoot: root });
    return r.ok ? [] : r.errors;
  };

  test("the fixture plan is valid", () => {
    assert.equal(validatePlan(billingPlan(), { workspaceRoot: root }).ok, true);
  });
  test("shape, ids and sizes", () => {
    assert.match(errs({})[0]!, /non-empty array/);
    assert.match(errs({ tasks: [task({ id: "Bad Id" })] }).join(), /id must match/);
    assert.match(errs({ tasks: [task({ id: "validate" })] }).join(), /reserved/);
    assert.match(errs({ tasks: [task(), task()] }).join(), /duplicated/);
    assert.match(errs({ tasks: [task({ objective: "x" })] }).join(), /objective/);
    assert.match(errs({ tasks: [task({ scope: [] })] }).join(), /scope/);
    const many = Array.from({ length: 9 }, (_, i) => task({ id: `t${i}` }));
    assert.match(errs({ tasks: many }).join(), /at most 8/);
  });
  test("context may be long (a contract); criteria may not; the error says which item is too long", () => {
    const long = "x".repeat(2000);
    assert.deepEqual(errs({ tasks: [task({ context: [long] })] }), []);
    assert.match(errs({ tasks: [task({ context: ["y".repeat(6001)] })] }).join(), /too long: split it/);
    assert.match(errs({ tasks: [task({ criteria: [long] })] }).join(), /criteria must be an array/);
  });
  test("dependencies: unknown, self and cycles are rejected", () => {
    assert.match(errs({ tasks: [task({ deps: ["ghost"] })] }).join(), /unknown task/);
    assert.match(errs({ tasks: [task({ deps: ["a"] })] }).join(), /itself/);
    assert.match(errs({ tasks: [task({ id: "a", deps: ["b"] }), task({ id: "b", deps: ["a"] })] }).join(), /cycle/);
  });
  test("scope must stay inside the workspace and away from reserved names", () => {
    assert.match(errs({ tasks: [task({ scope: ["../etc/passwd"] })] }).join(), /OUTSIDE_WORKSPACE/);
    assert.match(errs({ tasks: [task({ scope: [".git/config"] })] }).join(), /RESERVED/);
    assert.match(errs({ tasks: [task({ scope: ["/etc/passwd"] })] }).join(), /OUTSIDE_WORKSPACE/);
    assert.equal(errs({ tasks: [task({ scope: ["app/"] })] }).length, 0, "a directory scope is fine");
    assert.equal(errs({ tasks: [task({ scope: ["app/new_module.py"] })] }).length, 0, "a new file in the repo is fine");
  });
});

describe("planMission (supervisor)", () => {
  const input = () => ({ runId: "r1", objective: "Add discounts", contract: BILLING_CONTRACT, workspaceRoot: ws() });
  const json = (o: unknown) => ({ content: JSON.stringify(o) });

  test("a valid plan is accepted on the first try; the model is asked in the supervisor role with a schema", async () => {
    const m = new ScriptedModel(() => json(billingPlan()));
    const { plan, attempts } = await planMission(m, input());
    assert.equal(attempts, 1);
    assert.deepEqual(plan.tasks.map((t) => t.id), ["api", "consumer", "tests"]);
    assert.deepEqual(m.requests[0], { role: "supervisor", hasSchema: true, hasTools: false });
    const prompt = JSON.stringify(m.seen[0]);
    assert.match(prompt, /app\/schema\.py \(\d+ bytes\)/, "the repo listing is given");
    assert.match(prompt, /discount_bps/, "the contract is given");
  });

  test("a rejected plan is sent back ONCE with the exact validator errors, then accepted", async () => {
    const cyclic = { tasks: [task({ id: "a", deps: ["b"] }), task({ id: "b", deps: ["a"] })] };
    const m = new ScriptedModel((_msgs, n) => (n === 1 ? json(cyclic) : { content: "```json\n" + JSON.stringify(billingPlan()) + "\n```" }));
    const { attempts } = await planMission(m, input());
    assert.equal(attempts, 2);
    assert.match(JSON.stringify(m.seen[1]), /dependencies contain a cycle/);
  });

  test("two bad plans are an error, never a guess; escaping scopes are never accepted", async () => {
    const m = new ScriptedModel(() => json({ tasks: [task({ scope: ["../../etc/shadow"] })] }));
    await assert.rejects(planMission(m, input()), (e) => e instanceof PlanError && /OUTSIDE_WORKSPACE/.test(e.message));
    assert.equal(m.calls, 2);

    const junk = new ScriptedModel(() => ({ content: "sure! here is a plan: do the thing" }));
    await assert.rejects(planMission(junk, input()), PlanError);
  });
});
