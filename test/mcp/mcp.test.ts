// Plan 13 §3 (M1–M4): Synapser as an MCP server. The point of this suite is what a hostile or confused
// agent CANNOT do: approve its own gate, pick its role, read the code, touch another client's work.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { Journal } from "../../src/journal/journal.ts";
import { McpServer, serveStdio, type McpRole } from "../../src/mcp/server.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { buildCatalog } from "../../src/orchestration/catalog.ts";
import { readChallenge } from "../../src/orchestration/gates.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
const COMMANDS = [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }];
const PLAN: Plan = { tasks: [{ id: "schema", objective: "Do the schema work", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"], serves: ["schema", "imports"] }] };
const WF = {
  title: "Mark the schema", description: "Mark the schema file and keep the package importable",
  conditions: [
    { id: "schema", statement: "schema changed", checker: { kind: "diff", require: ["app/schema.py"] } },
    { id: "imports", statement: "package imports", checker: { kind: "command", commandId: "imports" } },
  ],
};

describe("MCP server", () => {
  let ws: string;
  let state: string;
  let mgr: WorkflowManager;
  let serverJ: Journal;

  const make = (startRequiresApproval = false) => {
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(["imports"]), profileIds: new Set(["w-schema"]), pollMs: 20,
      engine: new ProductionEngine({
        workspaceRoot: ws, stateDir: state, commands: COMMANDS, profiles: PROFILES, planner: async () => PLAN, pollMs: 20,
        models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] })),
        knownUsdPerRun: { "w-schema": 0.01 }, limits: { maxRepairRounds: 0, missionMs: 60_000 },
      }),
      ...(startRequiresApproval ? { startRequiresApproval: true } : {}),
    });
    serverJ = Journal.open(state, "_server");
    return (role: McpRole = "initiator", client = "claude-code") => {
      const srv = new McpServer({ manager: mgr, serverJournal: serverJ, role, catalog: () => buildCatalog(PROFILES, []) });
      let id = 0;
      const rpc = (method: string, params: Record<string, unknown> = {}) => srv.handle({ jsonrpc: "2.0", id: ++id, method, params });
      const open = async () => rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: client, version: "1" }, capabilities: {} });
      const tool = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await rpc("tools/call", { name, arguments: args })) as { result: { isError: boolean; content: { text: string }[] } };
        return { isError: r.result.isError, body: JSON.parse(r.result.content[0]!.text) as Record<string, unknown> };
      };
      return { srv, rpc, open, tool };
    };
  };

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "mcp-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "mcp-state-")));
  });
  afterEach(async () => {
    await mgr?.close();
    serverJ?.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const done = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const s = mgr.status(id)!.state;
      if (["DONE", "FAILED", "CANCELLED"].includes(s)) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    return "TIMEOUT";
  };

  test("handshake and tool surface by role; the client cannot choose its role (M1, M2)", async () => {
    const c = make()("initiator");
    const init = (await c.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" }, role: "operator", capabilities: { roles: ["worker"] } })) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    assert.equal(init.result.serverInfo.name, "synapser");
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(c.srv.session.role, "initiator", "M2: the role does not come from the client");
    const list = (await c.rpc("tools/list")) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["workflow_create", "workflow_start", "workflow_status", "gate_list", "gate_approve", "catalog_list"]) assert.ok(names.includes(n), n);

    const w = make()("worker");
    await w.open();
    const wl = (await w.rpc("tools/list")) as { result: { tools: { name: string }[] } };
    assert.deepEqual(wl.result.tools, [], "M1: a worker session has no initiator/approval tools");
    const r = await w.tool("gate_approve", { workflow_id: "x", gate: "start", code: "ABCDEF" });
    assert.equal(r.isError, true);
    assert.equal(r.body["error"], "UNKNOWN_TOOL");
  });

  test("create → start → status runs a workflow to DONE through the tool surface alone", async () => {
    const c = make()();
    await c.open();
    const bad = await c.tool("workflow_create", { title: "x", description: "short", conditions: [] });
    assert.equal(bad.isError, true);
    assert.ok(Array.isArray(bad.body["errors"]));

    const created = await c.tool("workflow_create", WF);
    assert.equal(created.isError, false);
    const id = String(created.body["workflow_id"]);
    const started = await c.tool("workflow_start", { workflow_id: id });
    assert.equal(started.isError, false);
    assert.equal(await done(id), "DONE");

    const st = await c.tool("workflow_status", { workflow_id: id });
    assert.equal(st.body["state"], "DONE");
    assert.deepEqual((st.body["conditions"] as { id: string; status: string }[]).map((x) => `${x.id}:${x.status}`), ["schema:SATISFIED", "imports:SATISFIED"]);
    const ev = await c.tool("workflow_events", { workflow_id: id, since_seq: 0, limit: 50 });
    assert.ok((ev.body["events"] as unknown[]).length > 5);
    const list = await c.tool("workflow_list");
    assert.deepEqual((list.body["workflows"] as { workflow_id: string }[]).map((x) => x.workflow_id), [id]);
    const cat = await c.tool("catalog_list");
    assert.equal((cat.body["profiles"] as { id: string }[])[0]!.id, "w-schema");
  });

  test("another client cannot read, edit, start, cancel or approve YOUR workflow", async () => {
    const mk = make();
    const a = mk("initiator", "claude-code");
    await a.open();
    const id = String((await a.tool("workflow_create", WF)).body["workflow_id"]);
    const b = mk("initiator", "some-other-agent");
    await b.open();
    for (const [tool, args] of [["workflow_status", { workflow_id: id }], ["workflow_start", { workflow_id: id }], ["workflow_cancel", { workflow_id: id }], ["workflow_events", { workflow_id: id }], ["workflow_edit", { workflow_id: id, workflow: WF }]] as const) {
      const r = await b.tool(tool, args as Record<string, unknown>);
      assert.equal(r.body["error"], "NOT_YOURS", tool);
    }
    assert.deepEqual((await b.tool("workflow_list")).body["workflows"], []);
    assert.equal(mgr.status(id)!.state, "DRAFT", "untouched");
  });

  test("a gate is released only by the out-of-band code; the agent cannot read it anywhere (E2)", async () => {
    const c = make(true)();
    await c.open();
    const id = String((await c.tool("workflow_create", WF)).body["workflow_id"]);
    assert.equal((await c.tool("workflow_start", { workflow_id: id })).body["state"], "AWAITING_START");

    const gates = await c.tool("gate_list", { workflow_id: id });
    const g = (gates.body["gates"] as { gate: string; kind: string }[])[0]!;
    assert.deepEqual([g.gate, g.kind], ["start", "start"]);

    const j = mgr.journalOf(id)!;
    const digest = (j.listEvents().find((e) => e.entity === "approval")!.data as { plan_digest: string }).plan_digest;
    const code = readChallenge(j, "start", digest)!;

    const noCode = await c.tool("gate_approve", { workflow_id: id, gate: "start", code: "" });
    const wrong = await c.tool("gate_approve", { workflow_id: id, gate: "start", code: "ZZZZZZ" });
    assert.equal(noCode.body["error"], "BAD_CHALLENGE");
    assert.equal(wrong.body["error"], "BAD_CHALLENGE");
    assert.equal(mgr.status(id)!.state, "AWAITING_START");

    // nothing the agent can ask for reveals the code
    const everything = JSON.stringify([gates, await c.tool("workflow_status", { workflow_id: id }), await c.tool("workflow_events", { workflow_id: id, limit: 500 }), await c.tool("catalog_list")]);
    assert.equal(everything.includes(code), false);
    assert.equal(JSON.stringify(j.listEvents()).includes(code), false, "nor does the ledger");

    const ok = await c.tool("gate_approve", { workflow_id: id, gate: "start", code });
    assert.deepEqual(ok.body, { ok: true, gate: "start", decision: "APPROVED" });
    assert.equal(await done(id), "DONE");
  });

  test("M3/M4: every call is on the ledger with who asked; reads add only their own call record", async () => {
    const mk = make();
    const c = mk("initiator", "claude-code");
    await c.open();
    const id = String((await c.tool("workflow_create", WF)).body["workflow_id"]);
    const j = mgr.journalOf(id)!;
    const before = j.listEvents().filter((e) => e.entity !== "mcp_call").length;
    await c.tool("workflow_status", { workflow_id: id });
    await c.tool("workflow_events", { workflow_id: id });
    await c.tool("gate_list", { workflow_id: id });
    await c.tool("catalog_list");
    await c.tool("gate_approve", { workflow_id: id, gate: "start", code: "SECRET1" });
    const calls = j.listEvents().filter((e) => e.entity === "mcp_call");
    assert.deepEqual(calls.map((e) => e.toState), ["workflow_create", "workflow_status", "workflow_events", "gate_list", "gate_approve"]);
    assert.ok(calls.every((e) => (e.data as { client: string; role: string }).client === "claude-code" && (e.data as { role: string }).role === "initiator"));
    assert.equal(j.listEvents().filter((e) => e.entity !== "mcp_call").length, before, "M4: reads wrote nothing else");
    assert.equal(JSON.stringify(j.listEvents()).includes("SECRET1"), false, "a submitted code is never stored");
    // calls that belong to no workflow go to the server journal
    assert.ok(serverJ.listEvents().some((e) => e.entity === "mcp_call" && e.toState === "catalog_list"));
  });

  test("protocol hygiene: ping, unknown method, call before initialize, and a parse error over stdio", async () => {
    const c = make()();
    assert.deepEqual(await c.rpc("ping"), { jsonrpc: "2.0", id: 1, result: {} });
    const pre = (await c.rpc("tools/call", { name: "catalog_list" })) as { error: { code: number } };
    assert.equal(pre.error.code, -32002);
    await c.open();
    const unk = (await c.rpc("nonsense")) as { error: { code: number } };
    assert.equal(unk.error.code, -32601);
    assert.equal(await c.srv.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

    const inp = new PassThrough();
    const out = new PassThrough();
    const lines: string[] = [];
    out.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter(Boolean)));
    const served = serveStdio(c.srv, inp, out);
    inp.write("{not json}\n");
    inp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`);
    inp.end();
    await served;
    const parsed = lines.map((l) => JSON.parse(l) as { id: number | null; error?: { code: number }; result?: unknown });
    assert.equal(parsed[0]!.error!.code, -32700);
    assert.equal(parsed[1]!.id, 9);
  });
});
