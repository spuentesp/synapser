// The real `synapser mcp` process over stdio, and the operator's CLI against the same state:
// an agent creates a workflow and asks to start it; the start gate holds; the human reads the code in
// the CLI; the agent relays it over MCP and the workflow leaves AWAITING_START.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BASELINE } from "../executor/env.ts";

const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const ENV = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ZOANTHROPE_BIN: process.env["ZOANTHROPE_BIN"] ?? "" };

let ws: string;
let state: string;
let cfg: string;
let proc: ChildProcessWithoutNullStreams | null = null;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "e2e-ws-")));
  cpSync(BASELINE, ws, { recursive: true });
  state = realpathSync(mkdtempSync(join(tmpdir(), "e2e-state-")));
  cfg = join(state, "..", `cfg-${Date.now()}.json`);
  writeFileSync(
    cfg,
    JSON.stringify({
      workspace: ws, stateDir: state, startRequiresApproval: true, research: false, profiles: ["nemotron-worker"],
      commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema"], timeoutMs: 20000 }],
    }),
  );
});
afterEach(() => {
  proc?.kill("SIGKILL");
  proc = null;
  rmSync(ws, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("agent ↔ synapser mcp (stdio) ↔ operator CLI: the gate holds until the human's code arrives", { timeout: 60_000 }, async () => {
  proc = spawn(process.execPath, [MAIN, "mcp", "--config", cfg], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  let buf = "";
  proc.stdout.on("data", (c: Buffer) => {
    buf += c.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
      pending.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method: string, params: object = {}) =>
    new Promise<{ result?: unknown; error?: unknown }>((ok, bad) => {
      const id = ++n;
      pending.set(id, ok);
      proc!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => bad(new Error(`timeout waiting for ${method}`)), 20_000);
    });
  const tool = async (name: string, args: object = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })) as { result: { isError: boolean; content: { text: string }[] } };
    return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
  };

  const init = (await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "claude-code" }, capabilities: {} })) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, "synapser");

  const created = await tool("workflow_create", {
    title: "Mark the schema", description: "Make the package importable and mark the schema",
    conditions: [{ id: "imports", statement: "package imports", checker: { kind: "command", commandId: "imports" } }],
  });
  const id = String(created["workflow_id"]);
  assert.match(id, /^wf-/);
  assert.equal((await tool("workflow_start", { workflow_id: id }))["state"], "AWAITING_START");
  assert.equal(((await tool("gate_list", { workflow_id: id }))["gates"] as { gate: string }[])[0]!.gate, "start");

  // the human, in the operator's console
  const shown = JSON.parse(execFileSync(process.execPath, [MAIN, "gate", "show", id, "start", "--config", cfg], { env: ENV, encoding: "utf8" })) as { code: string };
  assert.match(shown.code, /^[A-Z2-9]{6}$/);

  // an agent that guesses fails; the one the human told succeeds
  assert.equal((await tool("gate_approve", { workflow_id: id, gate: "start", code: "AAAAAA" }))["error"], "BAD_CHALLENGE");
  assert.deepEqual(await tool("gate_approve", { workflow_id: id, gate: "start", code: shown.code }), { ok: true, gate: "start", decision: "APPROVED" });

  // it left AWAITING_START (planning needs a model: with no key the run fails, which is fine here)
  let state1 = "AWAITING_START";
  for (let i = 0; i < 100 && state1 === "AWAITING_START"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state1 = String((await tool("workflow_status", { workflow_id: id }))["state"]);
  }
  assert.notEqual(state1, "AWAITING_START");
  const events = JSON.parse(execFileSync(process.execPath, [MAIN, "workflow", "events", id, "--config", cfg], { env: ENV, encoding: "utf8" })) as { entity: string; to: string | null }[];
  assert.ok(events.some((e) => e.entity === "approval" && e.to === "APPROVED"));
  assert.ok(events.some((e) => e.entity === "mcp_call"));
});
