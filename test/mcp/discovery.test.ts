import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createApi, type ApiServer } from "../../src/api/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import { validateMcpServerRegistry } from "../../src/mcp/registry.ts";
import { discoverRegisteredMcpServer, testRegisteredMcpTool } from "../../src/mcp/discovery.ts";
import { importArtifact } from "../../src/mcp/artifact-store.ts";

const temporary: string[] = [];
let api: ApiServer | undefined;
let manager: WorkflowManager | undefined;

afterEach(async () => {
  await api?.close();
  await manager?.close();
  api = undefined;
  manager = undefined;
  const makeWritable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  };
  for (const path of temporary.splice(0)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
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
  const packageRoot = join(fixtureDir, "package");
  mkdirSync(packageRoot);
  const serverPath = join(packageRoot, "server.cjs");
  writeFileSync(serverPath, serverSource);
  const artifactStoreRoot = join(fixtureDir, "artifact-store");
  const artifact = importArtifact(packageRoot, artifactStoreRoot);
  const parsed = validateMcpServerRegistry([{
    id: "local-discovery",
    enabled: true,
    origin: "file:///tmp/local-discovery-fixture",
    version: "1.0.0",
    command: process.execPath,
    args: [],
    artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
    expectedServer: { name: "local-discovery-fixture", version: "1" },
    profiles: { worker: ["inspect"] },
  }], ["worker"]);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const registration = parsed.servers[0]!;
  let discoveryCalls = 0;
  const connect = (id: string, profileId: string) => {
    assert.equal(id, registration.id);
    discoveryCalls++;
    return discoverRegisteredMcpServer(registration, profileId, artifactStoreRoot);
  };
  manager = new WorkflowManager({ stateDir, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(["worker"]), pollMs: 10, engine: { run: async () => ({ status: "DONE", reason: null }) } });
  api = createApi({
    stateDir,
    control: { manager, mcpServers: () => [registration], mcpDiscover: connect },
  });
  const base = `http://127.0.0.1:${await api.listen(0)}`;
  const listed = await fetch(`${base}/api/mcp`);
  assert.equal(listed.status, 200);
  const summary = await listed.json() as { servers: Record<string, unknown>[] };
  assert.deepEqual(summary.servers[0], {
    id: "local-discovery", enabled: true, version: "1.0.0",
    expectedServer: { name: "local-discovery-fixture", version: "1" }, profiles: { worker: ["inspect"] }, artifactPinned: true,
  });
  assert.equal(JSON.stringify(summary).includes(registration.command), false, "the UI summary must not reveal executable paths");
  assert.equal(JSON.stringify(summary).includes(serverSource), false, "the UI summary must not reveal command arguments");
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

test("HTTP discovery rejects an unpinned legacy server before invoking its connector", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "synapser-mcp-unpinned-state-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "synapser-mcp-unpinned-fixture-"));
  temporary.push(stateDir, fixtureDir);
  const workspace = join(fixtureDir, "workspace");
  mkdirSync(workspace);
  const parsed = validateMcpServerRegistry([{
    id: "legacy-server", enabled: true, origin: "file:///tmp/legacy", version: "1",
    command: "/usr/bin/node", args: [], expectedServer: { name: "legacy", version: "1" }, profiles: { worker: ["inspect"] },
  }], ["worker"]);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  let attemptedSpawn = false;
  manager = new WorkflowManager({ stateDir, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(["worker"]), pollMs: 10, engine: { run: async () => ({ status: "DONE", reason: null }) } });
  api = createApi({
    stateDir,
    control: { manager, mcpServers: () => parsed.servers, mcpDiscover: async () => { attemptedSpawn = true; throw new Error("must not be reached"); } },
  });
  const base = `http://127.0.0.1:${await api.listen(0)}`;
  const listed = await (await fetch(`${base}/api/mcp`)).json() as { servers: { artifactPinned: boolean }[] };
  assert.equal(listed.servers[0]?.artifactPinned, false);
  const response = await fetch(`${base}/api/mcp/legacy-server/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-synapser-token": api.token },
    body: JSON.stringify({ profileId: "worker" }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "MCP_ARTIFACT_UNPINNED" });
  assert.equal(attemptedSpawn, false);
});

test("operator test-call invokes only a selected allowlisted tool through the real sandboxed MCP process", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "synapser-mcp-test-call-state-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "synapser-mcp-test-call-fixture-"));
  temporary.push(stateDir, fixtureDir);
  const workspace = join(fixtureDir, "workspace");
  mkdirSync(workspace);
  const packageRoot = join(fixtureDir, "package");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "server.cjs"), [
    "let input = '';",
    "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const line = input.slice(0, i); input = input.slice(i + 1); const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-call-fixture', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }, { name: 'mutate', inputSchema: { type: 'object' } }] }); else if (request.method === 'tools/call') { if (request.params.name !== 'inspect') process.exit(24); reply(request.id, { content: [{ type: 'text', text: 'observed:' + request.params.arguments.value }] }); } else if (request.id !== undefined) reply(request.id, {}); } });",
  ].join("\n"));
  const artifactStoreRoot = join(fixtureDir, "artifact-store");
  const artifact = importArtifact(packageRoot, artifactStoreRoot);
  const parsed = validateMcpServerRegistry([{
    id: "local-call", enabled: true, origin: "file:///tmp/local-call-fixture", version: "1.0.0",
    command: process.execPath, args: [], artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
    expectedServer: { name: "local-call-fixture", version: "1" }, profiles: { worker: ["inspect"] },
  }], ["worker"]);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const registration = parsed.servers[0]!;
  let invocationCalls = 0;
  manager = new WorkflowManager({ stateDir, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(["worker"]), pollMs: 10, engine: { run: async () => ({ status: "DONE", reason: null }) } });
  api = createApi({
    stateDir,
    control: {
      manager,
      mcpServers: () => [registration],
      mcpTestCall: async (id, profileId, toolName, arguments_) => {
        invocationCalls++;
        assert.equal(id, registration.id);
        return testRegisteredMcpTool(registration, profileId, toolName, arguments_, artifactStoreRoot);
      },
    },
  });
  const base = `http://127.0.0.1:${await api.listen(0)}`;
  const headers = { "content-type": "application/json", origin: base, "x-synapser-token": api.token };
  const unauthenticated = await fetch(`${base}/api/mcp/local-call/test-call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: "worker", toolName: "inspect", arguments: { value: "hello" } }),
  });
  assert.equal(unauthenticated.status, 401);
  const disallowed = await fetch(`${base}/api/mcp/local-call/test-call`, {
    method: "POST", headers,
    body: JSON.stringify({ profileId: "worker", toolName: "mutate", arguments: {} }),
  });
  assert.equal(disallowed.status, 403);
  assert.deepEqual(await disallowed.json(), { error: "MCP_TOOL_NOT_ALLOWLISTED" });
  assert.equal(invocationCalls, 0, "unauthenticated and unallowlisted requests must not spawn a server");
  registration.enabled = false;
  const disabled = await fetch(`${base}/api/mcp/local-call/test-call`, {
    method: "POST", headers,
    body: JSON.stringify({ profileId: "worker", toolName: "inspect", arguments: { value: "hello" } }),
  });
  assert.equal(disabled.status, 409);
  assert.deepEqual(await disabled.json(), { error: "MCP_SERVER_DISABLED" });
  registration.enabled = true;
  assert.equal(invocationCalls, 0, "a disabled server must not spawn for a test call");
  const response = await fetch(`${base}/api/mcp/local-call/test-call`, {
    method: "POST", headers,
    body: JSON.stringify({ profileId: "worker", toolName: "inspect", arguments: { value: "hello" } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { toolName: "inspect", result: { content: [{ type: "text", text: "observed:hello" }] } });
  assert.equal(invocationCalls, 1);
});
