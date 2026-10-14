// Plan 13 P1: the workflow lifecycle on the REAL executor, journal, Zoanthrope and validation, with
// scripted/CLI-double agents. The decision to call a workflow DONE is the conditions', never an agent's.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { checkChain } from "../../src/audit/invariants.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { decideApproval, readChallenge } from "../../src/orchestration/gates.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { checkSameSnapshot, checkWaivers, checkWorkflowDone } from "../../src/workflow/invariants.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const OP: Actor = { id: "ana", role: "operator" };
const AGENT: Actor = { id: "claude-code#1", role: "initiator" };

const PROFILES: AgentProfile[] = [
  { ...cli("w-schema", "edit-schema"), tags: ["schema"] },
  { ...cli("w-client", "edit-client"), tags: ["client"] },
  { ...cli("w-readme", "edit-readme"), tags: ["docs"] },
  { ...cli("w-slow", "slow-edit-schema"), tags: ["slow"] },
];
const COMMANDS = [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }];

describe("WorkflowManager + ProductionEngine", () => {
  let ws: string;
  let state: string;
  let mgr: WorkflowManager;

  const wfInput = (over: Record<string, unknown> = {}) => ({
    title: "Document and wire the discount", description: "Mark the schema and the client, without touching the README",
    goals: ["schema and client are updated"],
    nonGoals: [{ statement: "do not touch the README", guard: { kind: "diff", forbid: ["README.md"] } }],
    conditions: [
      { id: "schema", statement: "app/schema.py was changed", checker: { kind: "diff", require: ["app/schema.py"] } },
      { id: "imports", statement: "the package imports", checker: { kind: "command", commandId: "imports" } },
    ],
    ...over,
  });
  const planOf = (...tasks: { id: string; scope: string[]; tags: string[]; serves: string[]; deps?: string[] }[]): Plan => ({
    tasks: tasks.map((t) => ({ id: t.id, objective: `Do the ${t.id} work`, scope: t.scope, criteria: [`${t.id} done`], deps: t.deps ?? [], tags: t.tags, serves: t.serves })),
  });

  const build = (opts: { plan: Plan; startRequiresApproval?: boolean; repairRounds?: number }) => {
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: COMMANDS, profiles: PROFILES,
      models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "nothing to do" })] })),
      knownUsdPerRun: { "w-schema": 0.01, "w-client": 0.01, "w-readme": 0.01, "w-slow": 0.01 },
      planner: async () => opts.plan,
      limits: { maxRepairRounds: opts.repairRounds ?? 0, concurrency: 2, missionMs: 60_000 },
      pollMs: 20,
    });
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(COMMANDS.map((c) => c.id)), profileIds: new Set(PROFILES.map((p) => p.id)),
      engine, ...(opts.startRequiresApproval ? { startRequiresApproval: true } : {}), pollMs: 20,
    });
    return mgr;
  };

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "wf-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "wf-state-")));
  });
  afterEach(async () => {
    await mgr?.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const created = (m: WorkflowManager, input: unknown, actor = AGENT) => {
    const r = m.create(input, actor);
    assert.ok(r.ok, JSON.stringify(r));
    return r.id;
  };
  const states = (m: WorkflowManager, id: string) =>
    m.journalOf(id)!.listEvents().filter((e) => e.entity === "workflow").map((e) => e.toState);

  test("a workflow runs to DONE only because its conditions were satisfied on one snapshot, with every invariant holding", async () => {
    const m = build({ plan: planOf({ id: "schema", scope: ["app/schema.py"], tags: ["schema"], serves: ["schema"] }, { id: "client", scope: ["app/client.py"], tags: ["client"], serves: ["imports"] }) });
    const id = created(m, wfInput());
    assert.equal(m.status(id)!.state, "DRAFT");
    const started = m.start(id, AGENT);
    assert.ok(started.ok && ["AWAITING_START", "PLANNING"].includes(started.state), "queued, then picked up");
    await m.settled(id);

    const v = m.status(id)!;
    assert.equal(v.state, "DONE", v.reason ?? "");
    assert.deepEqual(states(m, id), ["DRAFT", "AWAITING_START", "PLANNING", "RUNNING", "VERIFYING", "DONE"]);
    assert.deepEqual(v.conditions.map((c) => `${c.id}:${c.status}`), ["schema:SATISFIED", "imports:SATISFIED"]);
    assert.match(readFileSync(join(ws, "app/schema.py"), "utf8"), /edited by the agent/);
    assert.doesNotMatch(readFileSync(join(ws, "README.md"), "utf8"), /release notes/);

    const j = m.journalOf(id)!;
    assert.deepEqual([...checkWorkflowDone(j, v.workflow), ...checkSameSnapshot(j), ...checkWaivers(j, v.workflow), ...checkChain(j)], []);
    const decomposition = j.listEvents().find((e) => e.entity === "decomposition")!;
    assert.deepEqual((decomposition.data as { uncovered: string[] }).uncovered, []);
    // the guard (a non-goal) was evaluated in the same round
    assert.ok(j.listEvents().some((e) => e.entity === "condition" && e.entityId === "guard:0" && e.toState === "SATISFIED"));
  });

  test("a violated NON-GOAL blocks DONE even though every stated condition passes", async () => {
    const m = build({
      plan: planOf({ id: "schema", scope: ["app/schema.py"], tags: ["schema"], serves: ["schema"] }, { id: "readme", scope: ["README.md"], tags: ["docs"], serves: ["imports"] }),
    });
    const id = created(m, wfInput());
    m.start(id, OP);
    await m.settled(id);
    const v = m.status(id)!;
    assert.equal(v.state, "FAILED");
    assert.match(v.reason ?? "", /acceptance|condition/i);
    const guard = m.journalOf(id)!.listEvents().filter((e) => e.entity === "condition" && e.entityId === "guard:0").at(-1)!;
    assert.equal(guard.toState, "UNSATISFIED");
    assert.match(String((guard.data as { detail: string }).detail), /forbidden path\(s\) changed: README\.md/);
    assert.deepEqual(checkWorkflowDone(m.journalOf(id)!, v.workflow), [], "it never reached DONE");
  });

  test("an unserved required condition is refused by the planner's validator (C5), not discovered at the end", async () => {
    const { validatePlan } = await import("../../src/mission/plan.ts");
    const { conditionCoverage } = await import("../../src/mission/supervisor.ts");
    const { validateWorkflow } = await import("../../src/workflow/model.ts");
    const w = validateWorkflow({ id: "wf-x", ...wfInput() }, { workspaceRoot: ws, commandIds: new Set(["imports"]) });
    assert.ok(w.ok);
    const cov = conditionCoverage(w.workflow);
    const bad = validatePlan({ tasks: [{ id: "a", objective: "Change the schema file", scope: ["app/schema.py"], criteria: ["c"], deps: [], serves: ["schema", "ghost"] }] }, { workspaceRoot: ws, conditions: cov });
    assert.ok(!bad.ok);
    assert.match(bad.errors.join("|"), /UNKNOWN_CONDITION/);
    assert.match(bad.errors.join("|"), /CONDITION_UNSERVED: no task serves condition "imports"/);
  });

  test("start can require an operator decision; over MCP it needs the out-of-band code, over CLI/UI it does not", async () => {
    const m = build({ startRequiresApproval: true, plan: planOf({ id: "schema", scope: ["app/schema.py"], tags: ["schema"], serves: ["schema", "imports"] }) });
    const id = created(m, wfInput());
    assert.deepEqual(m.start(id, AGENT), { ok: true, state: "AWAITING_START" });
    const j = m.journalOf(id)!;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(m.status(id)!.state, "AWAITING_START", "the agent cannot start it by itself");

    const digest = (j.listEvents().find((e) => e.entity === "approval")!.data as { plan_digest: string }).plan_digest;
    const code = readChallenge(j, "start", digest)!;
    assert.match(code, /^[A-Z2-9]{6}$/);
    const base = { taskId: "start", planDigest: digest, currentDigest: digest, decision: "APPROVED" as const, actor: "claude-code#1" };
    assert.deepEqual(decideApproval(j, id, { ...base, channel: "mcp" }), { ok: false, code: "BAD_CHALLENGE" }, "an injected agent has no code");
    assert.deepEqual(decideApproval(j, id, { ...base, channel: "mcp", challenge: "AAAAAA" }), { ok: false, code: "BAD_CHALLENGE" });
    assert.deepEqual(decideApproval(j, id, { ...base, channel: "mcp", challenge: code.toLowerCase() }), { ok: true }, "the human relayed the code");
    await m.settled(id).catch(() => {});
    for (let i = 0; i < 200 && m.status(id)!.state !== "DONE"; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(m.status(id)!.state, "DONE");
    // the code never reached the ledger in the clear
    assert.equal(JSON.stringify(m.events(id)).includes(code), false);
    const ev = j.listEvents().find((e) => e.entity === "approval" && e.toState === "APPROVED")!;
    assert.equal((ev.data as { channel: string }).channel, "mcp");
  });

  test("cancel: a running workflow stops admitting work and ends CANCELLED; a queued one is cancelled outright", async () => {
    const m = build({ plan: planOf({ id: "slow", scope: ["app/schema.py"], tags: ["slow"], serves: ["schema", "imports"] }) });
    const a = created(m, wfInput());
    const b = created(m, wfInput());
    m.start(a, OP);
    m.start(b, OP); // one executor per workspace: b waits behind a
    for (let i = 0; i < 100 && !["RUNNING", "PLANNING"].includes(m.status(a)!.state); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(m.cancel(b, OP), { ok: true, state: "CANCELLED" });
    assert.equal(m.cancel(a, OP).ok, true);
    await m.settled(a);
    assert.equal(m.status(a)!.state, "CANCELLED");
    assert.equal(m.status(b)!.state, "CANCELLED");
    assert.equal(m.cancel(a, OP).ok, false, "terminal");
  });

  test("C2: editing the conditions while it runs is a revision, and DONE is judged against the NEW set", async () => {
    const m = build({ plan: planOf({ id: "slow", scope: ["app/schema.py"], tags: ["slow"], serves: ["schema", "imports"] }) });
    const id = created(m, wfInput());
    m.start(id, OP);
    for (let i = 0; i < 100 && m.status(id)!.state !== "RUNNING"; i++) await new Promise((r) => setTimeout(r, 10));
    const edited = m.edit(id, wfInput({ conditions: [...wfInput().conditions, { id: "marker", statement: "schema carries the agent marker", checker: { kind: "file", path: "app/schema.py", assert: { contains: "edited by the agent" } } }] }), OP);
    assert.deepEqual(edited, { ok: true, revision: 2 });
    await m.settled(id);
    const v = m.status(id)!;
    assert.equal(v.state, "DONE", v.reason ?? "");
    assert.equal(v.revision, 2);
    assert.ok(v.conditions.some((c) => c.id === "marker" && c.status === "SATISFIED"), "the added condition was enforced");
    const round = m.journalOf(id)!.listEvents().filter((e) => e.entity === "condition_round").at(-1)!;
    assert.equal((round.data as { doc_revision: number }).doc_revision, 2);
    assert.deepEqual(m.edit(id, wfInput(), OP), { ok: false, code: "TERMINAL" });
  });

  test("invalid input never creates a workflow, and unknown ids are unknown", () => {
    const m = build({ plan: planOf() });
    const r = m.create({ title: "x", description: "too short", conditions: [] }, AGENT);
    assert.equal(r.ok, false);
    assert.deepEqual(m.list(), []);
    assert.deepEqual(m.start("nope", OP), { ok: false, code: "UNKNOWN_WORKFLOW" });
    assert.equal(m.status("../etc"), null);
  });
});
