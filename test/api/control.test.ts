// Plan 13 §8–9: workflows, chat, catalog and config over the API. Writes need the token and same origin;
// the actor is fixed; the server still has no path to the executor.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { ChatService } from "../../src/chat/chat.ts";
import { Journal } from "../../src/journal/journal.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { buildCatalog } from "../../src/orchestration/catalog.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const PROFILES = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
const PLAN: Plan = { tasks: [{ id: "schema", objective: "Do the schema work", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"], serves: ["schema"] }] };
const WF = { title: "Mark the schema", description: "Mark the schema file", conditions: [{ id: "schema", statement: "schema changed", checker: { kind: "diff", require: ["app/schema.py"] } }] };

describe("API control", () => {
  let ws: string, state: string, mgr: WorkflowManager, sj: Journal, api: ApiServer, base: string;
  beforeEach(async () => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "ctl-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "ctl-state-")));
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(["w-schema"]), pollMs: 20,
      engine: new ProductionEngine({ workspaceRoot: ws, stateDir: state, commands: [], profiles: PROFILES, planner: async () => PLAN, pollMs: 20, models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] })), limits: { maxRepairRounds: 0, missionMs: 60_000 } }),
    });
    sj = Journal.open(state, "_server");
    const chat = new ChatService({
      model: new ScriptedModel((_m, n) => (n === 1 ? { calls: [call("draft_workflow", WF)] } : { content: "Drafted. Press Start." })),
      manager: mgr, journal: sj, catalog: () => buildCatalog(PROFILES, []), commandIds: () => [],
    });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr, chat, catalog: () => buildCatalog(PROFILES, []), config: () => ({ ok: true }) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  const send = (method: string, p: string, body?: unknown, h: Record<string, string> = {}) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...h }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const tok = () => ({ "x-synapser-token": api.token });

  test("writes need the token and same origin; reads do not", async () => {
    assert.equal((await send("POST", "/api/workflows", WF)).status, 401);
    assert.equal((await send("POST", "/api/workflows", WF, { ...tok(), origin: "http://evil.example" })).status, 403);
    assert.equal((await send("GET", "/api/workflows")).status, 200);
    assert.equal((await send("GET", "/api/catalog")).status, 200);
  });

  test("create → list → status → edit (revision) → start → DONE, all as the fixed operator", async () => {
    const c = await send("POST", "/api/workflows", WF, tok());
    assert.equal(c.status, 200);
    const { id } = (await c.json()) as { id: string };
    const list = (await (await send("GET", "/api/workflows")).json()) as { workflows: { id: string; state: string }[] };
    assert.deepEqual(list.workflows.map((w) => [w.id, w.state]), [[id, "DRAFT"]]);
    const e = await send("PUT", `/api/workflows/${id}`, { ...WF, title: "Renamed" }, tok());
    assert.equal(((await e.json()) as { revision: number }).revision, 2);
    assert.equal((await send("POST", `/api/workflows/${id}/start`, {}, tok())).status, 200);
    for (let i = 0; i < 300 && mgr.status(id)!.state !== "DONE"; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(mgr.status(id)!.state, "DONE");
    const st = (await (await send("GET", `/api/workflows/${id}`)).json()) as { state: string };
    assert.equal(st.state, "DONE");
  });

  test("an invalid workflow is 409 with every problem; unknown id 404", async () => {
    const r = await send("POST", "/api/workflows", { title: "x", description: "y", conditions: [] }, tok());
    assert.equal(r.status, 409);
    assert.ok(((await r.json()) as { errors: string[] }).errors.length > 0);
    assert.equal((await send("GET", "/api/workflows/nope")).status, 404);
  });

  test("chat: a message drafts a workflow (draft only), and the conversation is retrievable", async () => {
    const r = await send("POST", "/api/chat/send", { text: "mark the schema file" }, tok());
    assert.equal(r.status, 200);
    const out = (await r.json()) as { conversationId: string; drafts: string[]; reply: string };
    assert.equal(out.drafts.length, 1);
    assert.equal(mgr.status(out.drafts[0]!)!.state, "DRAFT");
    const h = (await (await send("GET", `/api/chat/${out.conversationId}`)).json()) as { messages: { role: string }[] };
    assert.deepEqual(h.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal((await send("POST", "/api/chat/send", { text: "x" })).status, 401);
    assert.equal((await send("POST", "/api/chat/send", {}, tok())).status, 400);
  });
});
