import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { authorizeMcpCall } from "../../src/effects/mcp-call.ts";
import { createCliBridge, type CliBridgeOptions } from "../../src/mcp/cli-bridge.ts";

// Plan 19 RCP6j: what one CLI run can see and do through its bridge. The bridge is driven as a JSON-RPC peer would drive it.
const schema = { type: "object", properties: { query: { type: "string" } }, additionalProperties: false };

function setup(over: Partial<CliBridgeOptions> = {}) {
  const calls = { readOnly: [] as { name: string; args: unknown }[], requests: [] as { server: string; tool: string; arguments: Record<string, unknown> }[] };
  const options: CliBridgeOptions = {
    readOnly: [{ name: "inspect", description: "read a file", inputSchema: schema }],
    effects: [{ name: "send_mail", description: "send a mail", inputSchema: schema, server: "mail", tool: "send_mail" }],
    callReadOnly: async (name, args) => {
      calls.readOnly.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
    requestEffect: async (r) => {
      calls.requests.push(r);
      return { id: "ef-7", state: "PENDING", summary: "call send_mail on mail" };
    },
    effectStatus: (id) => (id === "ef-7" ? { state: "DONE", reason: null, evidence: { output: "sent" } } : null),
    taskId: "cli-task",
    ...over,
  };
  return { bridge: createCliBridge(options), calls };
}
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

describe("plan 19 RCP6j: the CLI run's MCP bridge", () => {
  test("initialize answers the protocol the client asked for, and notifications get no reply", async () => {
    const { bridge } = setup();
    const init = (await bridge.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "synapser-bridge");
    assert.equal(await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  });

  test("tools/list shows only the run's selected tools and the status tool, never anything else", async () => {
    const { bridge } = setup();
    const list = (await bridge.handle(rpc(2, "tools/list"))) as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["effect_status", "inspect", "send_mail"]);
  });

  test("a tool the recipe did not select is refused, and nothing is called or requested", async () => {
    const { bridge, calls } = setup();
    const reply = (await bridge.handle(rpc(3, "tools/call", { name: "delete_everything", arguments: {} }))) as { error: { code: number; message: string } };
    assert.equal(reply.error.code, -32602);
    assert.match(reply.error.message, /not selected for this run/);
    assert.deepEqual(calls.readOnly, []);
    assert.deepEqual(calls.requests, []);
  });

  test("a selected read-only tool runs against the snapshot, and its output is marked as data", async () => {
    const { bridge, calls } = setup();
    const reply = (await bridge.handle(rpc(4, "tools/call", { name: "inspect", arguments: { query: "x" } }))) as { result: { content: { text: string }[] } };
    assert.deepEqual(calls.readOnly, [{ name: "inspect", args: { query: "x" } }]);
    assert.match(reply.result.content[0]!.text, /^UNTRUSTED_MCP_DATA /);
  });

  test("an effect is only a broker request: the bridge returns the pending state and never runs the tool itself", async () => {
    const { bridge, calls } = setup();
    const reply = (await bridge.handle(rpc(5, "tools/call", { name: "send_mail", arguments: { to: "ana@example.com" } }))) as { result: { content: { text: string }[] } };
    assert.deepEqual(calls.requests, [{ server: "mail", tool: "send_mail", arguments: { to: "ana@example.com" }, taskId: "cli-task" }]);
    assert.match(reply.result.content[0]!.text, /PENDING/);
    assert.deepEqual(calls.readOnly, []);
  });

  test("effect_status reads the outcome of a request from this run, and an unknown id is refused", async () => {
    const { bridge } = setup();
    const done = (await bridge.handle(rpc(6, "tools/call", { name: "effect_status", arguments: { id: "ef-7" } }))) as { result: { content: { text: string }[] } };
    assert.match(done.result.content[0]!.text, /DONE/);
    const unknown = (await bridge.handle(rpc(7, "tools/call", { name: "effect_status", arguments: { id: "ef-99" } }))) as { error: { code: number } };
    assert.equal(unknown.error.code, -32602);
  });

  test("an unknown method is refused with a method-not-found error", async () => {
    const { bridge } = setup();
    const reply = (await bridge.handle(rpc(8, "resources/list"))) as { error: { code: number } };
    assert.equal(reply.error.code, -32601);
  });

  test("the broker authorises a CLI worker only for the run's recipe grants, and a repair or a manual run never", () => {
    const grants = [{ serverId: "mail", toolName: "send_mail" }];
    const request = { params: { server: "mail", tool: "send_mail" } };
    assert.equal(authorizeMcpCall(grants, { ...request, role: "cli-worker" }), null);
    assert.match(authorizeMcpCall(grants, { params: { server: "mail", tool: "other" }, role: "cli-worker" }) ?? "", /not selected/);
    assert.match(authorizeMcpCall(undefined, { ...request, role: "cli-worker" }) ?? "", /no recipe MCP selection/);
    assert.match(authorizeMcpCall(grants, { ...request, role: "repair" }) ?? "", /only be requested by a worker/);
  });
});
