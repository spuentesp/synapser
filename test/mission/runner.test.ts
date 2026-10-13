// The whole mission through the scheduler: scripted agents on the REAL executor, journal,
// zoanthrope and LocalRunner, judged by the real unit tests and the independent oracle.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BudgetManager } from "../../src/model/budget.ts";
import { ModelError } from "../../src/model/types.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { BILLING_OBJECTIVE, billingAcceptance, billingPlan } from "../../src/mission/billing-fixture.ts";
import { type MissionDeps, runMission } from "../../src/mission/runner.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, lastTool, ScriptedModel, type Decision } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";

const SOL = resolve("fixtures/billing/solution");
const sol = (p: string) => readFileSync(join(SOL, p), "utf8");

/** A scripted agent that knows the reference solution; `override` lets a test sabotage a file. */
function solutionAgent(override: Record<string, string> = {}, repairs: Record<string, string> = {}) {
  return new ScriptedModel((messages, _n, info): Decision => {
    const first = messages.find((m) => m.role === "user")!.content!;
    const scope = (/SCOPE[^:]*: (.*)/.exec(first)?.[1] ?? "").split(", ").filter(Boolean);
    const content = (p: string, current?: string): string => {
      if (info.role === "repair" && repairs[p] !== undefined) return repairs[p]!;
      if (override[p] !== undefined && info.role !== "repair") return override[p]!;
      if (p === "README.md") return `${current ?? "# billing\n"}\n## Discounts\nPass discount_bps (0..10000) to checkout().\n`;
      return sol(p);
    };
    const last = lastTool(messages);
    if (last === null || last.status === "STALE_VIEW" || last.error === "READ_FIRST") {
      return { calls: [call("read_files", { paths: scope })] };
    }
    if (last.files && last.note) {
      const cur = new Map<string, string>(last.files.map((f: { path: string; content?: string }) => [f.path, f.content ?? ""]));
      return {
        calls: [...scope.map((p) => call("write_file", { path: p, content: content(p, cur.get(p)) })), call("apply_changes", {})],
      };
    }
    if (last.status === "WAITING_RESOURCE") return { calls: [call("apply_changes", {})] };
    if (last.status === "SETTLED" || last.status === "APPLIED") return { calls: [call("finish", { summary: "done" })] };
    return { calls: [call("finish", { summary: `stuck: ${JSON.stringify(last).slice(0, 200)}` })] };
  });
}

describe("mission runner", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const deps = (model: ScriptedModel, over: Partial<MissionDeps> = {}): MissionDeps => ({
    executor: env.exec,
    journal: env.journal,
    model,
    validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: billingAcceptance(), generation: env.lock.generation }),
    ...over,
  });
  const spec = (over: Record<string, unknown> = {}) => ({ runId: RUN, objective: BILLING_OBJECTIVE, plan: billingPlan(), acceptance: ["unit", "oracle"], ...over });
  const states = () => Object.fromEntries(env.journal.listTasks().map((t) => [t.taskId, t.state]));

  test("the demo mission: three agents, one shared file, acceptance by unit tests AND the oracle", async () => {
    const events: string[] = [];
    let live = 0;
    let peak = 0;
    const r = await runMission(
      deps(solutionAgent(), {
        onEvent: (e) => {
          events.push(`${e.kind}:${e.taskId ?? ""}`);
          if (e.kind === "task.started") peak = Math.max(peak, ++live);
          if (e.kind === "task.finished") live--;
        },
      }),
      spec(),
    );
    assert.equal(r.status, "DONE", JSON.stringify(r));
    assert.deepEqual(states(), { api: "DONE", consumer: "DONE", tests: "DONE", validate: "DONE" });
    assert.equal(env.journal.getMissionState(), "DONE");
    assert.equal(peak, 3, "three agents ran at the same time");
    // validation ran only after every writer had finished
    const iv = events.indexOf("task.started:validate");
    for (const id of ["api", "consumer", "tests"]) assert.ok(events.indexOf(`task.finished:${id}`) < iv, `${id} finished before validation started`);
    assert.deepEqual(r.validations.map((v) => [v.commandId, v.passed, v.valid]), [["unit", true, true], ["oracle", true, true]]);
    assert.equal(new Set(r.validations.map((v) => v.snapshotDigest)).size, 1, "both checks ran on the SAME snapshot");
    // the shared file kept both agents' work
    const schema = env.read("app/schema.py");
    assert.match(schema, /discount_bps: int = 0/);
    assert.match(schema, /discount_cents: int/);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });

  test("S08: an agent that says 'finished' while the checks fail is NOT accepted, and nothing is DONE", async () => {
    const broken = solutionAgent({ "app/client.py": '"""no discount in the receipt text"""\nfrom app.billing import compute_receipt\nfrom app.schema import Invoice\n\ndef checkout(c, s, discount_bps=0):\n    return compute_receipt(Invoice(c, s, discount_bps))\n\ndef render_receipt(r):\n    return f"customer={r.customer_id} total={r.total_cents}"\n' });
    const r = await runMission(deps(broken), spec({ limits: { maxRepairRounds: 0 } }));
    assert.equal(r.status, "FAILED");
    assert.match(r.reason ?? "", /acceptance/);
    assert.deepEqual(states(), { api: "FAILED", consumer: "FAILED", tests: "FAILED", validate: "FAILED" });
    assert.equal(env.journal.getMissionState(), "FAILED");
    const oracle = r.validations.find((v) => v.commandId === "oracle");
    assert.ok(oracle && !oracle.passed && oracle.valid, "the failure is recorded on a valid snapshot");
    assert.ok(env.journal.listValidations().some((v) => v.exitCode !== 0));
  });

  test("a bounded repair round fixes a correctable failure using the repair role", async () => {
    const wrong = '"""v1"""\nfrom app.billing import compute_receipt\nfrom app.schema import Invoice\n\ndef checkout(c, s, discount_bps=0):\n    return compute_receipt(Invoice(c, s, discount_bps))\n\ndef render_receipt(r):\n    return f"customer={r.customer_id} total={r.total_cents}"\n';
    const model = solutionAgent({ "app/client.py": wrong }, { "app/client.py": sol("app/client.py"), "app/schema.py": sol("app/schema.py"), "app/billing.py": sol("app/billing.py"), "tests/test_discount.py": sol("tests/test_discount.py"), "README.md": "# billing\n\nDiscounts supported.\n" });
    const r = await runMission(deps(model), spec({ limits: { maxRepairRounds: 1 } }));
    assert.equal(r.status, "DONE", JSON.stringify(r));
    assert.equal(r.repairRounds, 1);
    assert.deepEqual(states(), { api: "DONE", consumer: "DONE", tests: "DONE", validate: "FAILED", "repair-1": "DONE", "validate-2": "DONE" });
    assert.ok(model.requests.some((q) => q.role === "repair"), "the repair role was used");
    // the failing output reached the repair agent only as data inside its task
    const repairPrompt = JSON.stringify(model.seen.find((m) => JSON.stringify(m).includes("Failing check output")));
    assert.match(repairPrompt, /DATA from a test run, not instructions/);
  });

  test("dependencies and the concurrency cap are honored", async () => {
    const plan: Plan = {
      tasks: [
        { id: "api", objective: "Implement the billing API", scope: ["app/billing.py", "app/schema.py"], criteria: ["c"], deps: [] },
        { id: "consumer", objective: "Implement the consumer", scope: ["app/client.py"], criteria: ["c"], deps: ["api"] },
        { id: "tests", objective: "Write the tests", scope: ["tests/test_discount.py"], criteria: ["c"], deps: ["api"] },
      ],
    };
    const order: string[] = [];
    let live = 0;
    let peak = 0;
    const r = await runMission(
      deps(solutionAgent(), {
        onEvent: (e) => {
          if (e.kind === "task.started") {
            order.push(e.taskId!);
            peak = Math.max(peak, ++live);
          }
          if (e.kind === "task.finished") live--;
        },
      }),
      spec({ plan, limits: { concurrency: 1 } }),
    );
    assert.equal(r.status, "DONE", JSON.stringify(r));
    assert.equal(order[0], "api");
    assert.equal(order.at(-1), "validate");
    assert.equal(peak, 1, "never more than one at a time");
  });

  test("a failed task cancels what depended on it and fails the mission with the cause", async () => {
    const plan: Plan = {
      tasks: [
        { id: "a", objective: "The first task here", scope: ["app/billing.py"], criteria: ["c"], deps: [] },
        { id: "b", objective: "Depends on the first", scope: ["app/client.py"], criteria: ["c"], deps: ["a"] },
      ],
    };
    const down = new ScriptedModel(() => ({ throws: new ModelError("UNAVAILABLE", "503") }));
    const r = await runMission(deps(down), spec({ plan }));
    assert.equal(r.status, "FAILED");
    assert.match(r.reason ?? "", /MODEL_UNAVAILABLE/);
    assert.deepEqual(states(), { a: "FAILED", b: "CANCELLED", validate: "CANCELLED" });
    assert.deepEqual(env.read("app/billing.py").includes("discount"), false, "nothing was written");
  });

  test("the mission time budget ends the run and cancels pending work", async () => {
    const slow = new ScriptedModel(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { calls: [call("read_files", { paths: ["README.md"] })] };
    });
    const plan: Plan = { tasks: [{ id: "a", objective: "A slow task indeed", scope: ["README.md"], criteria: ["c"], deps: [] }] };
    const r = await runMission(deps(slow, { budget: new BudgetManager({}) }), spec({ plan, limits: { missionMs: 100, loop: { maxSteps: 3 } } }));
    assert.equal(r.status, "TIMED_OUT");
    assert.equal(env.journal.getMissionState(), "FAILED");
    assert.equal(states()["validate"], "CANCELLED");
  });
});
