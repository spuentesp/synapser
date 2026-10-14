// Plan 13 §8 (H1–H3): the chat drafts and explains; it cannot start, approve or cancel; its claims cite seqs.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { CHAT_TOOLS, ChatService } from "../../src/chat/chat.ts";
import { Journal } from "../../src/journal/journal.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { buildCatalog } from "../../src/orchestration/catalog.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel, type Decision } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
const PLAN: Plan = { tasks: [{ id: "schema", objective: "Do the schema work", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"], serves: ["schema"] }] };
const WF = { title: "Mark the schema", description: "Mark the schema file", conditions: [{ id: "schema", statement: "schema changed", checker: { kind: "diff", require: ["app/schema.py"] } }] };
const ACTOR = { id: "ui:operator", role: "operator" as const };

describe("chat", () => {
  let ws: string;
  let state: string;
  let mgr: WorkflowManager;
  let sj: Journal;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "chat-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "chat-state-")));
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(["imports"]), profileIds: new Set(["w-schema"]), pollMs: 20,
      engine: new ProductionEngine({ workspaceRoot: ws, stateDir: state, commands: [], profiles: PROFILES, planner: async () => PLAN, pollMs: 20, models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] })), limits: { maxRepairRounds: 0, missionMs: 60_000 } }),
    });
    sj = Journal.open(state, "_server");
  });
  afterEach(async () => {
    await mgr.close();
    sj.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  const svc = (decide: (n: number, text: string) => Decision) =>
    new ChatService({ model: new ScriptedModel((m, n) => decide(n, String(m.at(-1)?.content ?? ""))), manager: mgr, journal: sj, catalog: () => buildCatalog(PROFILES, []), commandIds: () => ["imports"] });

  test("H1: there is no tool that starts, cancels or approves — a hallucinated one is UNKNOWN_TOOL and changes nothing", async () => {
    const names = CHAT_TOOLS.map((t) => t.function.name);
    for (const bad of ["start", "cancel", "approve", "reject", "apply"]) assert.equal(names.some((n) => n.includes(bad)), false, bad);
    const c = svc((n) => (n === 1 ? { calls: [call("draft_workflow", WF), call("start_workflow", { workflow_id: "x" }), call("gate_approve", { gate: "start" })] } : { content: "Drafted it; press Start when ready." }));
    const r = await c.send(null, "do the schema thing and run it", ACTOR);
    assert.equal(r.drafts.length, 1);
    assert.deepEqual(r.trace.map((t) => [t.tool, t.ok]), [["draft_workflow", true], ["start_workflow", false], ["gate_approve", false]]);
    assert.equal(mgr.status(r.drafts[0]!)!.state, "DRAFT", "nothing started");
  });

  test("H2: a draft goes through the same validator; errors come back to the model, which corrects and retries", async () => {
    const bad = { ...WF, conditions: [{ id: "c1", statement: "x", checker: { kind: "command", commandId: "rm-rf" } }] };
    const c = svc((n) => (n === 1 ? { calls: [call("draft_workflow", bad)] } : n === 2 ? { calls: [call("draft_workflow", WF)] } : { content: "ok" }));
    const r = await c.send(null, "x", ACTOR);
    assert.deepEqual(r.trace.map((t) => t.ok), [false, true]);
    assert.equal(r.drafts.length, 1);
    assert.equal(mgr.list().length, 1, "the invalid draft was never created");
  });

  test("H3: explain_run returns facts with the ledger seq they came from, and the conversation is on the ledger", async () => {
    const id = (mgr.create(WF, ACTOR) as { id: string }).id;
    let seen = "";
    const c = svc((n, last) => {
      if (n === 1) return { calls: [call("explain_run", { workflow_id: id })] };
      seen = last;
      return { content: "It is a draft [#1]." };
    });
    const r = await c.send("conv-test-1", "what is going on?", ACTOR);
    const facts = JSON.parse(seen) as { state: string; conditions: { id: string; seq: number | null }[]; state_seq: number | null };
    assert.equal(facts.state, "DRAFT");
    assert.ok(facts.state_seq !== null || facts.conditions.length > 0);
    const hist = c.history(r.conversationId);
    assert.deepEqual(hist.map((m) => m.role), ["user", "assistant"]);
    assert.equal(c.conversations()[0]!.id, "conv-test-1");
  });

  test("a bad conversation id is replaced, not trusted; a model that never stops is cut at maxToolRounds", async () => {
    const c = new ChatService({ model: new ScriptedModel(() => ({ calls: [call("list_workflows", {})] })), manager: mgr, journal: sj, catalog: () => [], commandIds: () => [], maxToolRounds: 3 });
    const r = await c.send("../../etc", "loop", ACTOR);
    assert.match(r.conversationId, /^conv-/);
    assert.equal(r.trace.length, 3);
    assert.match(r.reply, /could not finish/);
  });
});
