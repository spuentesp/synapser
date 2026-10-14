// Characterization of the MCP wire behaviour as it is on main (plan 16, P16.2). These tests pin what the hand-written
// server does today, so the SDK swap is judged by its differences, not by memory. Each difference found after the swap
// is either fixed or written down in plan 16. mcp.test.ts pins the tool surface; this file pins the protocol around it.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { Advisor } from "../../src/advisor/advisor.ts";
import { Journal } from "../../src/journal/journal.ts";
import { McpServer, serveStdio } from "../../src/mcp/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { ScriptedModel } from "../agent/scripted.ts";

type Reply = { id?: number | string | null; result?: any; error?: { code: number; message: string } };

const WF = {
  title: "Mark the schema", description: "Mark the schema file and keep the package importable",
  conditions: [
    { id: "schema", statement: "schema changed", checker: { kind: "diff", require: ["app/schema.py"] } },
    { id: "imports", statement: "package imports", checker: { kind: "command", commandId: "imports" } },
  ],
};

async function start(advisorModel?: ScriptedModel) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "mcp-char-state-")));
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "mcp-char-ws-")));
  const serverJ = Journal.open(state, "_server");
  const mgr = new WorkflowManager({
    stateDir: state, workspaceRoot: ws, commandIds: new Set(["imports"]), profileIds: new Set(["w-schema"]), pollMs: 20,
    engine: { run: async () => ({ status: "DONE", reason: null }) },
    ...(advisorModel ? { advisor: (journal, id, workflow) => new Advisor({ journal, runId: id, workflow, model: advisorModel }) } : {}),
  });
  const srv = new McpServer({ manager: mgr, serverJournal: serverJ, catalog: () => [] });
  let n = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) => srv.handle({ jsonrpc: "2.0", id: ++n, method, params }) as Promise<Reply>;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { isError: r.result!.isError as boolean, body: JSON.parse(r.result!.content[0].text) as Record<string, unknown> };
  };
  const close = async () => {
    await mgr.close();
    serverJ.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  };
  return { srv, mgr, serverJ, rpc, tool, close };
}

const lastCall = (j: Journal) => j.listEvents().filter((e) => e.entity === "mcp_call").at(-1)!;

describe("characterization: what the hand-written server does today", () => {
  test("initialize answers the exact result, with 2024-11-05 and version 0.1.0 by default", async () => {
    const s = await start();
    try {
      const r = await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "x" }, capabilities: {} });
      assert.deepEqual(r.result, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synapser", version: "0.1.0" } });
    } finally {
      await s.close();
    }
  });

  test("today a client asking for 2025-06-18 is still answered 2024-11-05", async () => {
    const s = await start();
    try {
      const r = await s.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "x" }, capabilities: {} });
      assert.equal(r.result!.protocolVersion, "2024-11-05");
    } finally {
      await s.close();
    }
  });

  test("the client name is trimmed and cut at 60 characters; an empty name keeps 'unknown'", async () => {
    const s = await start();
    try {
      await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: `  ${"a".repeat(80)}  ` }, capabilities: {} });
      await s.tool("catalog_list");
      assert.equal((lastCall(s.serverJ).data as { client: string }).client, "a".repeat(60));
    } finally {
      await s.close();
    }
    const e = await start();
    try {
      await e.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "   " }, capabilities: {} });
      await e.tool("catalog_list");
      assert.equal((lastCall(e.serverJ).data as { client: string }).client, "unknown");
    } finally {
      await e.close();
    }
  });

  test("tools/list answers before initialize today, with the initiator surface", async () => {
    const s = await start();
    try {
      const r = await s.rpc("tools/list");
      assert.equal(r.result!.tools.length, 18);
    } finally {
      await s.close();
    }
  });

  test("tools/call before initialize is refused with -32002 and the message 'server not initialized'", async () => {
    const s = await start();
    try {
      const r = await s.rpc("tools/call", { name: "catalog_list" });
      assert.deepEqual(r.error, { code: -32002, message: "server not initialized" });
    } finally {
      await s.close();
    }
  });

  test("a call without a name is an UNKNOWN_TOOL with an empty name, and it is recorded as (unknown) with ok false", async () => {
    const s = await start();
    try {
      await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" }, capabilities: {} });
      const r = await s.rpc("tools/call", {});
      assert.equal(r.result!.isError, true);
      assert.deepEqual(JSON.parse(r.result!.content[0].text), { error: "UNKNOWN_TOOL", tool: "" });
      assert.equal(lastCall(s.serverJ).toState, "(unknown)");
      assert.equal((lastCall(s.serverJ).data as { ok: boolean }).ok, false);
    } finally {
      await s.close();
    }
  });

  test("an unknown tool name is refused as UNKNOWN_TOOL and recorded under its own name with ok false", async () => {
    const s = await start();
    try {
      await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" }, capabilities: {} });
      const r = await s.tool("nonsense_tool");
      assert.equal(r.isError, true);
      assert.deepEqual(r.body, { error: "UNKNOWN_TOOL", tool: "nonsense_tool" });
      assert.equal(lastCall(s.serverJ).toState, "nonsense_tool");
      assert.equal((lastCall(s.serverJ).data as { ok: boolean }).ok, false);
    } finally {
      await s.close();
    }
  });

  test("an unknown method with an id gets -32601 naming it; notifications get no reply", async () => {
    const s = await start();
    try {
      const r = await s.rpc("nonsense");
      assert.deepEqual(r.error, { code: -32601, message: "method not found: nonsense" });
      assert.equal(await s.srv.handle({ jsonrpc: "2.0", method: "notifications/whatever" }), null);
      assert.equal(await s.srv.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), null);
      assert.equal(await s.srv.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    } finally {
      await s.close();
    }
  });

  test("ping answers an empty result before and after initialize", async () => {
    const s = await start();
    try {
      assert.deepEqual(await s.rpc("ping"), { jsonrpc: "2.0", id: 1, result: {} });
      await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "x" }, capabilities: {} });
      assert.deepEqual((await s.rpc("ping")).result, {});
    } finally {
      await s.close();
    }
  });

  test("a successful call is one text block holding the JSON; a failed call is isError with the error object in one text block", async () => {
    const s = await start();
    try {
      await s.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "x" }, capabilities: {} });
      const ok = (await s.rpc("tools/call", { name: "catalog_list", arguments: {} })).result!;
      assert.equal(ok.isError, false);
      assert.equal(ok.content.length, 1);
      assert.equal(ok.content[0].type, "text");
      const bad = (await s.rpc("tools/call", { name: "workflow_status", arguments: { workflow_id: "wf-missing" } })).result!;
      assert.equal(bad.isError, true);
      assert.equal(bad.content.length, 1);
      assert.deepEqual(JSON.parse(bad.content[0].text), { error: "UNKNOWN_WORKFLOW" });
    } finally {
      await s.close();
    }
  });

  test("stdio: a bad JSON line gets -32700 with id null and the connection stays open for the next line", async () => {
    const s = await start();
    const inp = new PassThrough();
    const out = new PassThrough();
    const lines: Reply[] = [];
    out.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Reply)));
    const served = serveStdio(s.srv, inp, out);
    inp.write("{not json}\n");
    inp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
    inp.end();
    await served;
    try {
      assert.deepEqual(lines[0], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      assert.deepEqual(lines[1], { jsonrpc: "2.0", id: 9, result: {} });
    } finally {
      await s.close();
    }
  });

  test("stdio: requests are answered in arrival order, so a slow advise holds the answer to a later request", async () => {
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    const slow = new ScriptedModel(async () => {
      await held;
      return { content: JSON.stringify({ assessment: "held", interventions: [] }) };
    });
    const s = await start(slow);
    const inp = new PassThrough();
    const out = new PassThrough();
    const lines: Reply[] = [];
    out.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Reply)));
    const until = async (cond: () => boolean) => {
      for (const t0 = Date.now(); !cond(); ) {
        if (Date.now() - t0 > 5000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const send = (m: Record<string, unknown>) => inp.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    const served = serveStdio(s.srv, inp, out);
    try {
      send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "x" }, capabilities: {} } });
      send({ id: 2, method: "tools/call", params: { name: "workflow_create", arguments: WF } });
      await until(() => lines.some((l) => l.id === 2));
      const wf = JSON.parse(lines.find((l) => l.id === 2)!.result.content[0].text).workflow_id as string;
      // an advisor needs something to talk about: the same task the tool-surface suite inserts
      s.mgr.journalOf(wf)!.tx((t) => {
        t.insertMission({ runId: wf, objective: "o", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
        t.insertTask({ runId: wf, taskId: "schema", actorOwner: `${wf}:schema`, priority: 0, scope: ["app/schema.py"], spec: { kind: "agent", objective: "Do the schema work", criteria: ["c"], context: [] }, planRevision: 1, deps: [] });
      });
      send({ id: 3, method: "tools/call", params: { name: "advise", arguments: { workflow_id: wf, question: "wait?" } } });
      send({ id: 4, method: "tools/list" });
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(lines.map((l) => l.id), [1, 2], "today id 4 waits behind the held id 3");
      release();
      await until(() => lines.length === 4);
      assert.deepEqual(lines.map((l) => l.id), [1, 2, 3, 4]);
    } finally {
      release();
      inp.end();
      await served;
      await s.close();
    }
  });
});
