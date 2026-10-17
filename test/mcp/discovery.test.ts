import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createApi, type ApiServer } from "../../src/api/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { validateMcpServerRegistry } from "../../src/mcp/registry.ts";
import { discoverRegisteredMcpServer } from "../../src/mcp/discovery.ts";

const temporary: string[] = [];
let api: ApiServer | undefined;
let manager: WorkflowManager | undefined;

afterEach(async () => {
  await api?.close();
  await manager?.close();
  api = undefined;
  manager = undefined;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("operator MCP discovery crosses HTTP and a real process, filters tools, and never calls one", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "synapser-mcp-discovery-state-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "synapser-mcp-discovery-fixture-"));
  temporary.push(stateDir, fixtureDir);
  const workspace = join(fixtureDir, "workspace");
  mkdirSync(workspace);
  const serverSource = [
    "let input = '';",
    "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const line = input.slice(0, i); input = input.slice(i + 1); const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-discovery-fixture', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }, { name: 'write', inputSchema: { type: 'object' } }] }); else if (request.method === 'tools/call') process.exit(24); else if (request.id !== undefined) reply(request.id, {}); } });",
  ].join("\n");
  const parsed = validateMcpServerRegistry([{
    id: "local-discovery",
    enabled: true,
    origin: "file:///tmp/local-discovery-fixture",
    version: "1.0.0",
    command: process.execPath,
    args: ["-e", serverSource],
    expectedServer: { name: "local-discovery-fixture", version: "1" },
    profiles: { worker: ["inspect"] },
  }], ["worker"]);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const registration = parsed.servers[0]!;
  let discoveryCalls = 0;
  const connect = (id: string, profileId: string) => {
    assert.equal(id, registration.id);
    discoveryCalls++;
    return discoverRegisteredMcpServer(registration, profileId);
  };
  manager = new WorkflowManager({ stateDir, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(["worker"]), pollMs: 10, engine: { run: async () => ({ status: "DONE", reason: null }) } });
  api = createApi({
    stateDir,
    control: { manager, mcpServers: () => [registration], mcpDiscover: connect },
  });
  const base = `http://127.0.0.1:${await api.listen(0)}`;
  const unauthenticated = await fetch(`${base}/api/mcp/local-discovery/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId: "worker" }) });
  assert.equal(unauthenticated.status, 401);
  const unconfiguredProfile = await fetch(`${base}/api/mcp/local-discovery/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-synapser-token": api.token },
    body: JSON.stringify({ profileId: "reviewer" }),
  });
  assert.equal(unconfiguredProfile.status, 403);
  assert.equal(discoveryCalls, 0, "unauthenticated or unconfigured requests must not spawn the registered process");
  const response = await fetch(`${base}/api/mcp/local-discovery/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-synapser-token": api.token },
    body: JSON.stringify({ profileId: "worker" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { serverInfo: { name: string; version: string }; capabilities: unknown; tools: { name: string }[] };
  assert.deepEqual(result.serverInfo, { name: "local-discovery-fixture", version: "1" });
  assert.deepEqual(result.tools.map((tool) => tool.name), ["inspect"]);
  assert.equal("capabilities" in result, true);
  assert.equal(discoveryCalls, 1);
  // The fixture exits on tools/call, so a successful discovery also proves no tool was invoked.
});
