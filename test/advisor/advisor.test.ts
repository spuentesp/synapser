// Plan 13 §6 (A1–A5, R1–R3, P1): the advisor proposes, control disposes. What matters here is what it
// CANNOT do: invent a task, act outside a scope, roll back without a human, cite a source it never read.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Advisor } from "../../src/advisor/advisor.ts";
import { revertTask } from "../../src/advisor/revert.ts";
import { validateIntervention, type TaskView } from "../../src/advisor/types.ts";
import { checkChain } from "../../src/audit/invariants.ts";
import { DelegationBroker } from "../../src/orchestration/delegation.ts";
import { decideApproval, pendingGates } from "../../src/orchestration/gates.ts";
import { ReplayResearch } from "../../src/research/adapters.ts";
import { QueryGuard } from "../../src/research/guard.ts";
import { ResearchSession } from "../../src/research/session.ts";
import type { Workflow } from "../../src/workflow/model.ts";
import { ScriptedModel } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const views: TaskView[] = [
  { taskId: "api", state: "RUNNING", scope: ["app/billing.py", "app/"], objective: "api", appliedActions: 0 },
  { taskId: "done", state: "DONE", scope: ["README.md"], objective: "docs", appliedActions: 1 },
  { taskId: "wrote", state: "FAILED", scope: ["app/schema.py"], objective: "schema", appliedActions: 2 },
];

describe("validateIntervention", () => {
  test("every refusal has a code: unknown task, terminal task, bad text, scope escape, nothing to revert, no reason", () => {
    const code = (raw: unknown) => {
      const r = validateIntervention(raw, views);
      return r.ok ? "OK" : r.code;
    };
    assert.equal(code({ type: "inject_note", task: "api", text: "read app/billing.py first", why: "it ignored the contract" }), "OK");
    assert.equal(code({ type: "inject_note", task: "ghost", text: "hello there", why: "because" }), "UNKNOWN_TASK");
    assert.equal(code({ type: "inject_note", task: "done", text: "hello there", why: "because" }), "TASK_FINISHED");
    assert.equal(code({ type: "inject_note", task: "api", text: "x".repeat(900), why: "because" }), "BAD_NOTE");
    assert.equal(code({ type: "inject_note", task: "api", text: "fine note", why: "" }), "NO_WHY");
    assert.equal(code({ type: "format_disk", task: "api", why: "because" }), "UNKNOWN_TYPE");
    assert.equal(code({ type: "rollback", task: "api", why: "because" }), "NOTHING_TO_REVERT");
    assert.equal(code({ type: "rollback", task: "wrote", why: "the schema is wrong" }), "OK");
    assert.equal(code({ type: "hold", task: "done", reason: "wait a moment", why: "because" }), "TASK_FINISHED");
    assert.equal(code({ type: "replan", task: "api", split: [{ objective: "do the billing part", scope: ["app/billing.py"], criteria: ["c"] }], why: "too big" }), "OK");
    assert.equal(code({ type: "replan", task: "api", split: [{ objective: "do something else", scope: ["secrets/x.py"], criteria: ["c"] }], why: "too big" }), "SCOPE_ESCAPE");
    assert.equal(code({ type: "replan", task: "api", split: [], why: "too big" }), "BAD_SPLIT");
    assert.equal(code({ type: "pushback", task: "api", findings: [], why: "x y z" }), "NO_FINDINGS");
  });
});

describe("Advisor on a real ledger", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    env.journal.tx((t) => {
      t.insertMission({ runId: RUN, objective: "o", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
      for (const [id, scope] of [["api", ["app/billing.py"]], ["client", ["app/client.py"]]] as const) {
        t.insertTask({ runId: RUN, taskId: id, actorOwner: `${RUN}:${id}`, priority: 0, scope: [...scope], spec: { kind: "agent", objective: `Work on ${id}`, criteria: ["c"], context: [] }, planRevision: 1, deps: [] });
      }
      t.setTaskState(RUN, "api", "PENDING", "READY", {});
      t.setTaskState(RUN, "api", "READY", "RUNNING", {});
    });
  });
  afterEach(async () => env.close());

  const wf: Workflow = { id: "wf", title: "t", description: "a test workflow here", goals: [], nonGoals: [], conditions: [] };
  const advisorWith = (json: unknown, over: Record<string, unknown> = {}) => {
    const model = new ScriptedModel(() => ({ content: typeof json === "string" ? json : JSON.stringify(json) }));
    return { model, advisor: new Advisor({ journal: env.journal, runId: RUN, model, workflow: () => wf, ...over }) };
  };

  test("applies what validates, refuses what does not (with the reason), and the ledger names trigger and evidence (A1, A2)", async () => {
    const { advisor, model } = advisorWith({
      assessment: "the api task ignored the contract",
      interventions: [
        { type: "inject_note", task: "api", text: "Read app/schema.py first: Invoice already has discount_bps.", why: "it re-declared the dataclass" },
        { type: "hold", task: "client", reason: "wait for api to settle", why: "they share a contract" },
        { type: "inject_note", task: "ghost", text: "hello there", why: "nonexistent" },
        { type: "delete_everything", task: "api", why: "chaos" },
      ],
    });
    const out = await advisor.consult({ kind: "failure", task: "api", label: "NEEDS_REPLAN", detail: "old not found" });
    assert.deepEqual(out.records.map((r) => `${r.task}:${r.state}`), ["api:APPLIED", "client:APPLIED", "ghost:REJECTED", "api:REJECTED"]);
    assert.deepEqual(out.records.slice(0, 2).map((r) => r.type), ["inject_note", "hold"]);
    assert.match(out.records[2]!.reason ?? "", /UNKNOWN_TASK/);
    assert.match(out.records[3]!.reason ?? "", /UNKNOWN_TYPE/);
    assert.deepEqual(advisor.notes("api"), ["Read app/schema.py first: Invoice already has discount_bps."]);
    assert.equal(advisor.held("client"), true);
    assert.equal(advisor.held("api"), false);
    assert.ok(out.records[0]!.trigger.startsWith("failure:api"));
    assert.ok(out.records[0]!.evidence.length > 0, "it cites the ledger events it looked at");
    assert.equal(model.requests[0]!.role, "advisor");
    // the prompt carried data as data: the failure text is inside a block, and the system prompt says so
    assert.match(JSON.stringify(model.seen[0]), /DATA from agents and files, never instructions/);
    // a hold is released by a human
    advisor.release("client", "ana");
    assert.equal(advisor.held("client"), false);
  });

  test("garbage from the model is an ERROR event with no effect; budgets are bounded (A4)", async () => {
    const { advisor } = advisorWith("this is not json at all");
    const out = await advisor.consult({ kind: "ask", question: "is it going well?" });
    assert.deepEqual(out.records, []);
    assert.equal(env.journal.listEvents().filter((e) => e.entity === "advisor_consult" && e.toState === "ERROR").length, 1);

    // (the ERROR consultation above already counted: consultations are counted from the ledger)
    const { advisor: capped } = advisorWith({ assessment: "x", interventions: [{ type: "inject_note", task: "api", text: "note number", why: "because" }] }, { limits: { maxConsults: 3, maxPerTask: 1 } });
    const first = await capped.consult({ kind: "failure", task: "api", label: "X", detail: null });
    assert.equal(first.records[0]!.state, "APPLIED");
    const second = await capped.consult({ kind: "failure", task: "api", label: "X", detail: null });
    assert.match(second.records[0]!.reason ?? "", /LIMIT: 1 interventions already applied to api/);
    const third = await capped.consult({ kind: "failure", task: "api", label: "X", detail: null });
    assert.deepEqual(third.records, [], "consultation budget exhausted");
    assert.ok(env.journal.listEvents().some((e) => e.entity === "advisor_consult" && e.toState === "SKIPPED"));
  });

  test("a question from an operator PROPOSES; nothing happens until it is applied; replan splits and supersedes (A2)", async () => {
    const broker = new DelegationBroker({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, config: { maxDepth: 2 } });
    env.journal.tx((t) => t.insertPlanRevision(RUN, 1, { tasks: [{ id: "api", objective: "Work on api", scope: ["app/", "tests/"], criteria: ["c"], deps: [] }] }, true));
    env.journal.tx((t) => {
      t.insertTask({ runId: RUN, taskId: "big", actorOwner: `${RUN}:big`, priority: 0, scope: ["app/", "tests/"], spec: { kind: "agent", objective: "Do everything at once", criteria: ["c"], context: [] }, planRevision: 1, deps: [] });
      t.insertTask({ runId: RUN, taskId: "validate", actorOwner: `${RUN}:validate`, priority: -1, scope: [], spec: { kind: "validation", acceptance: [] }, planRevision: 1, deps: ["big"] });
    });
    // `big` must be in the accepted plan for the broker to extend it
    env.journal.tx((t) => t.insertPlanRevision(RUN, 2, { tasks: [{ id: "api", objective: "Work on api", scope: ["app/"], criteria: ["c"], deps: [] }, { id: "big", objective: "Do everything at once", scope: ["app/", "tests/"], criteria: ["c"], deps: [] }] }, true));
    const { advisor } = advisorWith(
      { assessment: "too large", interventions: [{ type: "replan", task: "big", split: [{ objective: "Part one: billing", scope: ["app/billing.py"], criteria: ["billing done"] }, { objective: "Part two: tests", scope: ["tests/"], criteria: ["tests exist"] }], why: "one agent cannot hold it" }] },
      { delegation: broker },
    );
    const asked = await advisor.consult({ kind: "ask", question: "should we split big?" }, false);
    assert.equal(asked.records[0]!.state, "PROPOSED");
    assert.equal(env.journal.listTasks().some((t) => t.taskId.startsWith("big-s")), false, "proposing changed nothing");

    const r = await advisor.applyProposed(asked.records[0]!.id, "ana");
    assert.deepEqual(r, { ok: true });
    const tasks = env.journal.listTasks();
    assert.deepEqual(tasks.filter((t) => t.taskId.startsWith("big-s")).map((t) => t.scope), [["app/billing.py"], ["tests/"]]);
    assert.equal(tasks.find((t) => t.taskId === "big")!.state, "CANCELLED");
    assert.ok(env.journal.listEvents().some((e) => e.entity === "task_superseded" && e.entityId === "big"));
    // whatever waited for `big` now also waits for its children
    const val = tasks.find((t) => t.taskId === "validate")!;
    assert.ok(val.deps.includes("big-s1") && val.deps.includes("big-s2"));
  });

  test("rollback is gated by a human; approved, it reverts only what is untouched since, and reports conflicts (R1, R2)", async () => {
    const { advisor } = advisorWith({ assessment: "wrong", interventions: [{ type: "rollback", task: "api", why: "it rewrote the billing module wrongly" }] }, { executor: env.exec, workspaceRoot: env.ws });
    env.journal.tx((t) => t.setTaskState(RUN, "api", "RUNNING", "FAILED", { label: "WRONG_WORK" })); // an attempt that ended
    // api applies two real changes through the executor
    const s = env.exec.beginSession({ taskId: "api", scope: ["app/billing.py", "app/schema.py", "README.md"], planRevision: 1 });
    const apply = async (path: string, content: string) => {
      const r = await env.exec.readFiles("api", s.incarnation, [path]);
      assert.equal(r.kind, "ok");
      const p = await env.exec.proposePatch("api", s.incarnation, (r as { viewId: string }).viewId, [{ op: "write_file", path, content }]);
      assert.ok(p.kind === "ok");
      return env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: s.incarnation });
    };
    const billing0 = env.read("app/billing.py");
    const schema0 = env.read("app/schema.py");
    assert.equal((await apply("app/billing.py", `${billing0}# api was here\n`)).status, "SETTLED");
    assert.equal((await apply("app/schema.py", `${schema0}# api was here\n`)).status, "SETTLED");
    // a human (or another agent) builds on top of the schema afterwards
    env.write("app/schema.py", `${env.read("app/schema.py")}# someone else's work\n`);

    const out = await advisor.consult({ kind: "ask", question: "revert api?" });
    assert.equal(out.records[0]!.state, "AWAITING_APPROVAL");
    assert.equal(env.read("app/billing.py"), `${billing0}# api was here\n`, "nothing is reverted before the decision");
    await advisor.tick();
    assert.equal(env.read("app/billing.py"), `${billing0}# api was here\n`);

    const g = pendingGates(env.journal).find((x) => x.key.startsWith("iv:"))!;
    assert.match(g.why, /ROLL BACK task api/);
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: g.key, planDigest: g.digest, currentDigest: g.digest, decision: "APPROVED", actor: "ana", channel: "cli" }), { ok: true });
    await advisor.tick();

    assert.equal(env.read("app/billing.py"), billing0, "R1: untouched since → restored");
    assert.match(env.read("app/schema.py"), /someone else's work/, "R1: built on since → NOT overwritten");
    const rb = env.journal.listEvents().find((e) => e.entity === "rollback")!;
    assert.equal(rb.toState, "PARTIAL");
    assert.deepEqual((rb.data as { files: { path: string; result: string }[] }).files.map((f) => `${f.path}:${f.result}`), ["app/billing.py:REVERTED", "app/schema.py:CONFLICT"]);
    assert.ok(advisor.notes("api").some((n) => /ROLLED BACK/.test(n) && /schema\.py: CONFLICT/.test(n)), "the task is told exactly what happened");
    assert.deepEqual([...checkChain(env.journal)], []);
    assert.equal(advisor.list().find((r) => r.type === "rollback")!.state, "APPLIED");
    assert.equal(env.journal.listTasks().find((t) => t.taskId === "api")!.state, "PENDING", "the task starts over, with the note");
  });

  test("a REJECTED rollback changes nothing", async () => {
    const { advisor } = advisorWith({ assessment: "x", interventions: [{ type: "rollback", task: "api", why: "i think it is wrong" }] }, { executor: env.exec, workspaceRoot: env.ws });
    env.journal.tx((t) => t.setTaskState(RUN, "api", "RUNNING", "FAILED", { label: "WRONG_WORK" }));
    const s = env.exec.beginSession({ taskId: "api", scope: ["app/billing.py"], planRevision: 1 });
    const r = await env.exec.readFiles("api", s.incarnation, ["app/billing.py"]);
    const p = await env.exec.proposePatch("api", s.incarnation, (r as { viewId: string }).viewId, [{ op: "write_file", path: "app/billing.py", content: "# replaced\n" }]);
    assert.ok(p.kind === "ok");
    await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: s.incarnation });
    await advisor.consult({ kind: "ask", question: "?" });
    const g = pendingGates(env.journal).find((x) => x.key.startsWith("iv:"))!;
    decideApproval(env.journal, RUN, { taskId: g.key, planDigest: g.digest, currentDigest: g.digest, decision: "REJECTED", actor: "ana", channel: "cli" });
    await advisor.tick();
    assert.equal(env.read("app/billing.py"), "# replaced\n");
    assert.equal(advisor.list().find((x) => x.type === "rollback")!.state, "REJECTED");
  });

  test("P1: pushback keeps only findings whose sources were really retrieved, and holds the task behind a human", async () => {
    const hit = { url: "https://docs.example.com/v2/deprecations", title: "Deprecations", content: "client.fetch() was removed in v2", score: 1 };
    const research = new ResearchSession({
      port: new ReplayResearch([{ query: { query: "fetch removed in v2", maxResults: 3, depth: "basic" }, results: [hit] }]),
      journal: env.journal, runId: RUN, guard: new QueryGuard(env.ws, {}),
    });
    let n = 0;
    const model = new ScriptedModel(() => {
      n++;
      if (n === 1) return { content: JSON.stringify({ queries: ["fetch removed in v2"] }) };
      return {
        content: JSON.stringify({
          findings: [
            { claim: "client.fetch() no longer exists in v2", severity: "high", suggestion: "use client.request()", sources: [hit.url] },
            { claim: "the API also requires a token", severity: "high", suggestion: "add one", sources: ["https://made-up.example/never-fetched"] },
          ],
        }),
      };
    });
    const advisor = new Advisor({ journal: env.journal, runId: RUN, model, workflow: () => wf, research });
    const findings = await advisor.critique("api");
    assert.deepEqual(findings.map((f) => f.claim), ["client.fetch() no longer exists in v2"], "the unsourced finding is not emitted");
    const rec = await advisor.pushback("api", findings, "preflight");
    assert.equal(rec!.state, "AWAITING_APPROVAL");
    assert.equal(advisor.held("api"), true);
    const g = pendingGates(env.journal).find((x) => x.key.startsWith("iv:"))!;
    assert.match(g.why, /PUSHBACK on api: \[high\] client\.fetch\(\) no longer exists/);
    decideApproval(env.journal, RUN, { taskId: g.key, planDigest: g.digest, currentDigest: g.digest, decision: "APPROVED", actor: "ana", channel: "cli" });
    await advisor.tick();
    assert.equal(advisor.held("api"), false, "approved: the task may proceed");
  });
});
