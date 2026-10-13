// Plan 10 at mission level: steps are ROUTED to profiles and run through the AgentRunner port, with
// approval gates, advisory steps that cannot write, and the W1–W4 + I1–I5 checkers on the result.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CliOneShotRunner, NativeLoopRunner } from "../../src/agents/adapters.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { AgentRunnerRegistry } from "../../src/agents/port.ts";
import { checkAcceptance, checkChain, checkGrantBeforeWrite } from "../../src/audit/invariants.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import { buildCatalog } from "../../src/orchestration/catalog.ts";
import { decideApproval, pendingApprovals, planDigest } from "../../src/orchestration/gates.ts";
import { checkAdvisorsReadOnly, checkBudget, checkDispatch, checkGates } from "../../src/orchestration/invariants.ts";
import type { OrchestrationDeps } from "../../src/orchestration/dispatch.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const advisor = (id: string, mode: string): AgentProfile => ({ ...cli(id, mode), role: "advisor", tags: ["review"] });
const PROFILES: AgentProfile[] = [
  { ...cli("w-schema", "edit-schema"), tags: ["schema"] },
  { ...cli("w-client", "edit-client"), tags: ["client"] },
  { ...cli("w-readme", "edit-readme"), tags: ["docs"] },
  advisor("adv-good", "noop"),
  advisor("adv-bad", "edit-client"),
];

describe("orchestrated mission", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const model = new ScriptedModel(() => ({ calls: [call("finish", { summary: "unused" })] }));
  const orchestration = (over: Partial<OrchestrationDeps> = {}): OrchestrationDeps => ({
    catalog: buildCatalog(PROFILES, [], { knownUsdPerRun: { "w-schema": 0.01, "w-client": 0.01, "w-readme": 0.01, "adv-good": 0.02 } }),
    profiles: PROFILES,
    registry: new AgentRunnerRegistry([new NativeLoopRunner(model), new CliOneShotRunner()]),
    executor: env.exec,
    workspaceRoot: env.ws,
    generation: env.lock.generation,
    ...over,
  });
  const validation = () =>
    new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }], generation: env.lock.generation });
  const mission = (plan: Plan, o: OrchestrationDeps, extra: object = {}) =>
    runMission(
      { executor: env.exec, journal: env.journal, model, validation: validation(), orchestration: o, ...extra } as never,
      { runId: RUN, objective: "docs and schema", plan, acceptance: ["imports"], limits: { concurrency: 3, maxRepairRounds: 0, missionMs: 60_000 } },
    );
  const T = (id: string, scope: string[], over: Record<string, unknown> = {}) => ({ id, objective: `Do ${id} work`, scope, criteria: [`${id} done`], deps: [], ...over });
  const ledgerOk = (o: OrchestrationDeps) => [
    ...checkDispatch(env.journal, o.catalog),
    ...checkAdvisorsReadOnly(env.journal),
    ...checkGates(env.journal),
    ...checkBudget(env.journal),
    ...checkGrantBeforeWrite(env.journal),
    ...checkAcceptance(env.journal),
    ...checkChain(env.journal),
  ];

  test("routed mission: writers are chosen by tag fit and cost, the advisor reviews without writing, the gate is auto-approved with an actor", async () => {
    const plan: Plan = {
      tasks: [
        T("schema", ["app/schema.py"], { tags: ["schema"] }),
        T("client", ["app/client.py"], { tags: ["client"], profile: "w-schema" }), // a bad suggestion: tags and policy win
        T("review", ["app/schema.py"], { kind: "advise", deps: ["schema"] }),
        T("docs", ["README.md"], { tags: ["docs"], gates: ["approval"], deps: ["review"] }),
      ],
    };
    const o = orchestration({ approval: { auto: ({ taskId }) => (taskId === "docs" ? { approve: true, actor: "policy:docs-ok", reason: "docs only" } : null), pollMs: 20 } });
    const r = await mission(plan, o);
    assert.equal(r.status, "DONE", r.reason ?? "");

    const dispatch = Object.fromEntries(
      env.journal.listEvents().filter((e) => e.entity === "dispatch").map((e) => [e.entityId, e.data as Record<string, unknown>]),
    );
    assert.equal(dispatch["schema"]!["profile"], "w-schema");
    assert.equal(dispatch["client"]!["profile"], "w-client", "the suggestion w-schema was overridden by capability fit");
    assert.equal(dispatch["review"]!["profile"], "adv-good");
    assert.equal(dispatch["review"]!["kind"], "advise");
    assert.equal(dispatch["docs"]!["profile"], "w-readme");
    assert.match(env.read("app/client.py"), /client edit/);
    assert.match(env.read("README.md"), /release notes/);

    const approval = env.journal.listEvents().filter((e) => e.entity === "approval");
    assert.deepEqual(approval.map((e) => e.toState), ["PENDING", "APPROVED"]);
    assert.equal((approval[1]!.data as { actor: string }).actor, "policy:docs-ok");
    assert.deepEqual(ledgerOk(o), []);
  });

  test("a gate WAITS for a human: the step does not start until the approval for this plan is recorded", async () => {
    const plan: Plan = { tasks: [T("docs", ["README.md"], { tags: ["docs"], gates: ["approval"] })] };
    const o = orchestration({ approval: { pollMs: 10 } });
    const done = mission(plan, o);
    const digest = planDigest(plan);
    for (let i = 0; i < 300 && pendingApprovals(env.journal, digest).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(pendingApprovals(env.journal, digest), ["docs"]);
    assert.equal(env.journal.listTasks().find((t) => t.taskId === "docs")!.state, "PENDING");
    assert.equal(env.journal.listEvents().some((e) => e.entity === "dispatch"), false, "nothing dispatched while waiting");
    assert.doesNotMatch(env.read("README.md"), /release notes/);

    // an approval for a DIFFERENT plan digest is refused; the right one releases the step
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: "docs", planDigest: "other", currentDigest: digest, decision: "APPROVED", actor: "ana" }), { ok: false, code: "STALE_DIGEST" });
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: "docs", planDigest: digest, currentDigest: digest, decision: "APPROVED", actor: "ana" }), { ok: true });
    const r = await done;
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.match(env.read("README.md"), /release notes/);
    assert.deepEqual(ledgerOk(o), []);
  });

  test("a REJECTED gate fails the mission and the gated step never runs", async () => {
    const plan: Plan = { tasks: [T("schema", ["app/schema.py"], { tags: ["schema"] }), T("docs", ["README.md"], { tags: ["docs"], gates: ["approval"], deps: ["schema"] })] };
    const o = orchestration({ approval: { auto: ({ taskId }) => (taskId === "docs" ? { approve: false, actor: "policy:no-docs", reason: "frozen" } : null), pollMs: 10 } });
    const r = await mission(plan, o);
    assert.equal(r.status, "FAILED");
    assert.match(r.reason ?? "", /approval rejected for docs/);
    assert.equal(env.journal.listEvents().some((e) => e.entity === "dispatch" && e.entityId === "docs"), false);
    assert.doesNotMatch(env.read("README.md"), /release notes/);
    assert.deepEqual(ledgerOk(o), []);
  });

  test("W2: an advisor that edits files is refused — its change is never integrated and the step fails", async () => {
    const plan: Plan = { tasks: [T("review", ["app/client.py"], { kind: "advise", profile: "adv-bad" })] };
    const o = orchestration({ catalog: buildCatalog(PROFILES.filter((p) => p.id !== "adv-good"), [], { knownUsdPerRun: { "adv-bad": 0.02 } }), profiles: PROFILES.filter((p) => p.id !== "adv-good") });
    const before = env.read("app/client.py");
    const r = await mission(plan, o);
    assert.equal(r.status, "FAILED");
    assert.match(r.reason ?? "", /ADVISOR_CHANGED_FILES/);
    assert.equal(env.read("app/client.py"), before, "the live tree is untouched");
    assert.deepEqual(env.journal.listAllActions(), [], "no action was ever prepared for an advisory step");
  });

  test("unknown cost: the step runs, the alert is on the ledger, and W4 holds", async () => {
    const plan: Plan = { tasks: [T("schema", ["app/schema.py"], { tags: ["schema"] })] };
    const o = orchestration({ catalog: buildCatalog(PROFILES, []) }); // no tariffs, no history → all unknown
    const r = await mission(plan, o);
    assert.equal(r.status, "DONE", r.reason ?? "");
    const alerts = env.journal.listEvents().filter((e) => e.entity === "alert");
    assert.deepEqual(alerts.map((a) => `${a.entityId}:${a.toState}`), ["schema:COST_UNKNOWN"]);
    assert.deepEqual(checkBudget(env.journal), []);
  });

  test("without orchestration the scheduler behaves exactly as before (no dispatch events)", async () => {
    const plan: Plan = { tasks: [T("x", ["app/schema.py"])] };
    const m = new ScriptedModel((msgs, n) => {
      if (n === 1) return { calls: [call("read_files", { paths: ["app/schema.py"] })] };
      if (n === 2) return { calls: [call("write_file", { path: "app/schema.py", content: `${env.read("app/schema.py")}# plain\n` }), call("apply_changes", {})] };
      return { calls: [call("finish", { summary: "ok" })] };
    });
    const r = await runMission({ executor: env.exec, journal: env.journal, model: m, validation: validation() }, { runId: RUN, objective: "o", plan, acceptance: ["imports"], limits: { maxRepairRounds: 0 } });
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.equal(env.journal.listEvents().some((e) => e.entity === "dispatch"), false);
  });
});
