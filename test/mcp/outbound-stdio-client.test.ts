import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { connectRegisteredMcpServer, connectStdioMcpServer } from "../../src/mcp/outbound-stdio-client.ts";
import { validateMcpServerRegistry } from "../../src/mcp/registry.ts";
import { importArtifact } from "../../src/mcp/artifact-store.ts";
import { RunMemoryScope } from "../../src/agents/run-memory-scope.ts";

// This is an actual child process speaking MCP's newline-delimited JSON-RPC protocol. It is intentionally
// small enough to make the adversarial wire cases explicit instead of relying on an in-process server double.
const SERVER = String.raw`
const fs = require('node:fs');
const pinnedHelper = require('./mcp-helper.cjs');
const { spawn } = require('node:child_process');
const net = require('node:net');
const mode = process.env.TEST_MODE || 'normal';
function processGroup() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2]);
}
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ pid: process.pid, pgid: processGroup() }));
if (process.env.OBSERVED_ENV_FILE) fs.writeFileSync(process.env.OBSERVED_ENV_FILE, JSON.stringify({ home: process.env.HOME || null, inheritedSecret: process.env.SYNAPSER_MCP_TEST_INHERITED_SECRET || null }));
if (process.env.RESOURCE_LIMITS_FILE) {
  const entry = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
  const relative = entry ? entry.slice(3) : null;
  const root = relative === null ? null : '/sys/fs/cgroup' + relative;
  const read = name => root === null ? null : fs.readFileSync(root + '/' + name, 'utf8').trim();
  fs.writeFileSync(process.env.RESOURCE_LIMITS_FILE, JSON.stringify({ relative, memoryMax: read('memory.max'), pidsMax: read('pids.max') }));
}
if (process.env.ARTIFACT_WRITE_PROBE_FILE) {
  try { fs.writeFileSync(__dirname + '/artifact-write-probe', 'must fail'); fs.writeFileSync(process.env.ARTIFACT_WRITE_PROBE_FILE, JSON.stringify({ writable: true })); }
  catch (error) { fs.writeFileSync(process.env.ARTIFACT_WRITE_PROBE_FILE, JSON.stringify({ writable: false, error: error.code || error.message })); }
}
if (process.env.HOST_PROBE_PATH) {
  try { fs.writeFileSync('external-read.json', JSON.stringify({ content: fs.readFileSync(process.env.HOST_PROBE_PATH, 'utf8') })); }
  catch (error) { fs.writeFileSync('external-read.json', JSON.stringify({ error: error.code || error.message })); }
}
if (process.env.HOST_PROBE_PID && process.env.HOST_PROBE_SENTINEL && process.env.PID_PROBE_FILE) {
  const target = '/proc/' + process.env.HOST_PROBE_PID;
  try {
    const visible = fs.existsSync(target);
    if (!visible) fs.writeFileSync(process.env.PID_PROBE_FILE, JSON.stringify({ visible: false }));
    else {
      const bytes = fs.readFileSync(target + '/environ');
      const expected = Buffer.from('SYNAPSER_FIXTURE_SENTINEL=' + process.env.HOST_PROBE_SENTINEL);
      const sentinelPresent = bytes.includes(Buffer.concat([expected, Buffer.from([0])]));
      fs.writeFileSync(process.env.PID_PROBE_FILE, JSON.stringify({ visible: true, sentinelPresent }));
    }
  } catch (error) {
    fs.writeFileSync(process.env.PID_PROBE_FILE, JSON.stringify({ visible: fs.existsSync(target), error: error.code || error.message }));
  }
}
if (process.env.NETWORK_PROBE_PORT) {
  const socket = net.connect(Number(process.env.NETWORK_PROBE_PORT), '127.0.0.1');
  socket.setTimeout(500);
  socket.on('connect', () => { fs.writeFileSync('network-probe.json', JSON.stringify({ connected: true })); socket.destroy(); });
  socket.on('error', error => fs.writeFileSync('network-probe.json', JSON.stringify({ connected: false, error: error.code || error.message })));
  socket.on('timeout', () => { fs.writeFileSync('network-probe.json', JSON.stringify({ connected: false, error: 'timeout' })); socket.destroy(); });
}
let calls = 0;
let initialized = false;
function append(file, text) { if (file) fs.appendFileSync(file, text + '\n'); }
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function onLine(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    if (process.env.INIT_REQUEST_FILE) fs.writeFileSync(process.env.INIT_REQUEST_FILE, JSON.stringify(request.params));
    if (mode === 'malformed') { process.stdout.write('this is not JSON\n'); return; }
    if (mode === 'oversized') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'local-fixture', version: '1', padding: 'x'.repeat(700) } } }) + '\n'); return; }
    if (mode === 'timeout-init') return;
    if (mode === 'exit-init') process.exit(23);
    if (mode === 'child-timeout-list' || mode === 'child-close') {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      if (process.env.GRANDCHILD_PID_FILE) fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, JSON.stringify({ spawned: true, namespacePid: child.pid }));
    }
    if (mode === 'detached-child-close') {
      const childScript = "const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');const pgid=Number(stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[2]);fs.writeFileSync(process.env.GRANDCHILD_PID_FILE,JSON.stringify({spawned:true,namespacePid:process.pid,pgid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      spawn(process.execPath, ['-e', childScript], { stdio: 'ignore', detached: true, env: process.env });
    }
    if (mode === 'coalesced-invalid') {
      const init = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'x'.repeat(120), version: '1' } } });
      const unsolicited = JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} });
      if (process.env.FRAME_LENGTHS_FILE) fs.writeFileSync(process.env.FRAME_LENGTHS_FILE, Buffer.byteLength(init) + ' ' + Buffer.byteLength(unsolicited) + ' ' + Buffer.byteLength(init + '\n' + unsolicited + '\n'));
      process.stdout.write(init + '\n' + unsolicited + '\n');
      return;
    }
    const serverInfo = mode === 'bad-identity' ? { name: 'local-fixture' }
      : mode === 'wrong-name' ? { name: 'unexpected-fixture', version: '1' }
      : mode === 'wrong-version' ? { name: 'local-fixture', version: '2' }
      : { name: 'local-fixture', version: '1' };
    if (serverInfo.version === '1') serverInfo.version = pinnedHelper.version;
    reply(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo });
    return;
  }
  if (request.method === 'notifications/initialized') {
    initialized = true;
    append(process.env.HANDSHAKE_FILE, 'notifications/initialized');
    return;
  }
  if (request.method === 'tools/list') {
    if (mode === 'timeout-list') return;
    if (mode === 'child-timeout-list') return;
    if (mode === 'exit-list') process.exit(24);
    if (!initialized) append(process.env.HANDSHAKE_FILE, 'tools/list-before-initialized');
    if (process.env.HANDSHAKE_FILE && mode !== 'normal') append(process.env.HANDSHAKE_FILE, 'tools/list');
    if (mode === 'paginated' || mode === 'pagination-limit') {
      const cursor = request.params.cursor;
      append(process.env.CURSOR_FILE, cursor || '<first>');
      if (mode === 'paginated') {
        if (!cursor) return reply(request.id, { tools: [{ name: 'page-one', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
        return reply(request.id, { tools: [{ name: 'page-two', inputSchema: { type: 'object' } }] });
      }
      const page = cursor ? Number(cursor.slice(1)) : 1;
      return reply(request.id, { tools: [{ name: 'page-' + page, inputSchema: { type: 'object' } }], nextCursor: 'p' + (page + 1) });
    }
    const tools = [
      { name: 'echo', description: 'Return the input for this local test', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['text'], additionalProperties: false } },
      { name: 'raw', description: 'Unbounded input used to test frame limits', inputSchema: { type: 'object' } },
    ];
    if (mode === 'output-schema-good' || mode === 'output-schema-invalid') tools[0] = { name: 'echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false } };
    if (mode === 'unsupported-schema') tools.push({ name: 'regex', inputSchema: { type: 'object', properties: { value: { type: 'string', pattern: '^safe$' } } } });
    reply(request.id, { tools });
    return;
  }
  if (request.method === 'tools/call') {
    calls++;
    if (process.env.CALLS_FILE) fs.writeFileSync(process.env.CALLS_FILE, String(calls));
    if (mode === 'tool-error') return reply(request.id, { content: [{ type: 'text', text: 'expected tool failure' }], isError: true });
    if (mode === 'invalid-content') return reply(request.id, { content: [{ type: 'text', text: 42 }], isError: false });
    if (mode === 'output-schema-good') return reply(request.id, { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: 'ok' }, isError: false });
    if (mode === 'output-schema-invalid') return reply(request.id, { content: [{ type: 'text', text: 'bad' }], structuredContent: { result: 7 }, isError: false });
    reply(request.id, { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }], isError: false });
  }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const i = input.indexOf('\n');
    if (i < 0) break;
    const line = input.slice(0, i); input = input.slice(i + 1);
    onLine(line);
  }
});
`;

const dirs: string[] = [];
afterEach(() => {
  const makeWritable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  };
  for (const dir of dirs.splice(0)) {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "synapser-outbound-mcp-"));
  dirs.push(dir);
  const pidFile = join(dir, "pid");
  const homeDir = join(dir, "home");
  mkdirSync(homeDir);
  const grandchildPidFile = join(dir, "grandchild-pid");
  const callsFile = join(dir, "calls");
  const handshakeFile = join(dir, "handshake");
  const cursorFile = join(dir, "cursors");
  const frameLengthsFile = join(dir, "frame-lengths");
  const observedEnvFile = join(dir, "observed-env");
  const initRequestFile = join(dir, "init-request");
  const resourceLimitsFile = join(dir, "resource-limits.json");
  writeFileSync(join(dir, "mcp-helper.cjs"), "module.exports = { version: '1' };\n");
  const options = {
    command: process.execPath,
    args: ["-e", SERVER],
    cwd: dir,
    env: { TEST_MODE: mode, PID_FILE: pidFile, HOME: homeDir, GRANDCHILD_PID_FILE: grandchildPidFile, CALLS_FILE: callsFile, HANDSHAKE_FILE: handshakeFile, CURSOR_FILE: cursorFile, FRAME_LENGTHS_FILE: frameLengthsFile, OBSERVED_ENV_FILE: observedEnvFile, INIT_REQUEST_FILE: initRequestFile, RESOURCE_LIMITS_FILE: resourceLimitsFile } as Record<string, string>,
    timeoutMs: 250,
    callTimeoutMs: 250,
    killGraceMs: 500,
    maxMessageBytes: mode === "oversized" || mode === "coalesced-invalid" ? 256 : 1024,
  };
  return { options, dir, pidFile, homeDir, grandchildPidFile, callsFile, handshakeFile, cursorFile, frameLengthsFile, observedEnvFile, initRequestFile, resourceLimitsFile };
}

function registrationFor(options: ReturnType<typeof fixture>["options"], profiles: Record<string, string[]> = { worker: ["echo"] }) {
  const packageRoot = join(options.cwd!, "mcp-package");
  mkdirSync(packageRoot, { recursive: true });
  const serverPath = join(packageRoot, "local-mcp-server.cjs");
  writeFileSync(serverPath, SERVER);
  writeFileSync(join(packageRoot, "mcp-helper.cjs"), readFileSync(join(options.cwd!, "mcp-helper.cjs")));
  const artifactStoreRoot = join(options.cwd!, "mcp-artifacts");
  const artifact = importArtifact(packageRoot, artifactStoreRoot);
  const validation = validateMcpServerRegistry([{
    id: "local-fixture",
    enabled: true,
    origin: "file:///tmp/local-fixture",
    version: "1.0.0",
    command: options.command,
    args: [],
    artifact: { digest: artifact.digest, entrypoint: "local-mcp-server.cjs" },
    expectedServer: { name: "local-fixture", version: "1" },
    profiles,
  }], ["worker"]);
  assert.equal(validation.ok, true, "test registration must pass the operator-owned registry validator");
  return validation.servers[0]!;
}

function registeredOptions(options: ReturnType<typeof fixture>["options"], profiles?: Record<string, string[]>) {
  const artifactStoreRoot = join(options.cwd!, "mcp-artifacts");
  return {
    registration: registrationFor(options, profiles),
    profileId: "worker",
    artifactStoreRoot,
    env: { ...options.env, ARTIFACT_WRITE_PROBE_FILE: join(options.cwd!, "artifact-write-probe.json") },
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    callTimeoutMs: options.callTimeoutMs,
    killGraceMs: options.killGraceMs,
    maxMessageBytes: options.maxMessageBytes,
  };
}

function assertServerStarted(markerFile: string): void {
  // The test awaits client.close(), a timeout teardown, or a failed startup; those operations do not settle until
  // systemd confirms the scope is inactive with an empty cgroup. This marker only proves this fixture was launched.
  assert.ok(existsSync(markerFile), "the MCP fixture wrote its startup marker");
}

async function assertDescendantSpawned(markerFile: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 30 && !existsSync(markerFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(markerFile), "the MCP fixture launched the test descendant");
  const record = JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, unknown>;
  assert.equal(record["spawned"], true);
  return record;
}

test("outbound stdio client initializes, discovers tools, validates inputs, and calls a local server", async () => {
  const { options, pidFile, callsFile, homeDir, initRequestFile, observedEnvFile } = fixture();
  const client = await connectStdioMcpServer(options);
  assert.deepEqual(client.serverInfo, { name: "local-fixture", version: "1" });
  assert.deepEqual(client.capabilities, { tools: {} });
  assert.deepEqual(JSON.parse(readFileSync(initRequestFile, "utf8")), {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "synapser", version: "0.1.0" },
  }, "SDK transport must retain the explicitly pinned legacy initialization contract");
  assert.deepEqual(JSON.parse(readFileSync(observedEnvFile, "utf8")), { home: homeDir, inheritedSecret: null });
  assert.deepEqual(Object.keys(client).sort(), ["callTool", "capabilities", "close", "listTools", "serverInfo"]);
  assert.equal("request" in client, false, "the connector does not expose arbitrary JSON-RPC methods");
  assert.equal("notification" in client, false, "the connector does not expose arbitrary JSON-RPC notifications");

  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["echo", "raw"]);
  assert.deepEqual(tools[0]?.inputSchema, {
    type: "object",
    properties: { text: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["text"],
    additionalProperties: false,
  });

  await assert.rejects(client.callTool("echo", { text: "" }), /does not match schema|too short/);
  assert.equal(existsSync(callsFile), false, "invalid inputs must be rejected before crossing the process boundary");
  await assert.rejects(client.callTool("not-discovered", {}), /not registered/);
  assert.equal(existsSync(callsFile), false, "unknown tools must not reach the server");
  await assert.rejects(client.callTool("raw", { data: "x".repeat(2_000) }), /MCP request exceeds message limit/);
  assert.equal(existsSync(callsFile), false, "oversized requests must not reach the server");

  const result = await client.callTool("echo", { text: "composed request" });
  assert.deepEqual(result, { content: [{ type: "text", text: '{"text":"composed request"}' }], isError: false });
  assert.equal(readFileSync(callsFile, "utf8"), "1");

  await client.close();
  assertServerStarted(pidFile);
});

test("malformed response frames fail closed and confirm scope teardown", async () => {
  const { options, pidFile } = fixture("malformed");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  assertServerStarted(pidFile);
});

test("oversized response frames fail closed and confirm scope teardown", async () => {
  const { options, pidFile } = fixture("oversized");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  assertServerStarted(pidFile);
});

test("coalesced frames are subject to the SDK's accumulated-buffer limit", async () => {
  const { options, pidFile, frameLengthsFile } = fixture("coalesced-invalid");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  const [first, second, combined] = readFileSync(frameLengthsFile, "utf8").trim().split(" ").map(Number);
  assert.ok(first! < 256);
  assert.ok(second! < 256);
  assert.ok(combined! > 256);
  assertServerStarted(pidFile);
});

test("a timed-out request poisons the session and confirms scope teardown", async () => {
  const { options, pidFile } = fixture("timeout-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /timed out during tools\/list/);
  assertServerStarted(pidFile);
});

test("a server exit during an outstanding request rejects and closes the session", async () => {
  const { options, pidFile } = fixture("exit-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /failed during tools\/list/);
  assertServerStarted(pidFile);
});

test("a server exit during initialization is reported after scope teardown", async () => {
  const { options, pidFile } = fixture("exit-init");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  assertServerStarted(pidFile);
});

test("server identity must include both name and version", async () => {
  const { options, pidFile } = fixture("bad-identity");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  assertServerStarted(pidFile);
});

test("registered MCP connection rejects a legacy unpinned entry before spawning", async () => {
  const { options, pidFile } = fixture("normal");
  const registered = registeredOptions(options);
  const { artifact: _artifact, ...legacyRegistration } = registered.registration;
  await assert.rejects(connectRegisteredMcpServer({ ...registered, registration: legacyRegistration }), /MCP_ARTIFACT_UNPINNED/);
  assert.equal(existsSync(pidFile), false, "an unpinned artifact must be rejected before process startup");
});

test("registered MCP connection requires the exact operator-pinned server name and version", async (t) => {
  for (const mode of ["wrong-name", "wrong-version"]) {
    await t.test(`rejects ${mode}`, async () => {
      const { options, pidFile } = fixture(mode);
      await assert.rejects(connectRegisteredMcpServer(registeredOptions(options)), /identity|server.*(?:name|version)|expected/i);
      assertServerStarted(pidFile);
    });
  }
});

test("registered MCP connection exposes only the profile allowlist and blocks direct calls outside it", async () => {
  const { options, pidFile, callsFile } = fixture();
  const registered = registeredOptions(options, { worker: ["echo"] });
  writeFileSync(join(options.cwd!, "mcp-package", "local-mcp-server.cjs"), "process.exit(25);\n");
  const client = await connectRegisteredMcpServer(registered);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"], "tools/list must contain only the effective profile allowlist");
    assert.deepEqual(JSON.parse(readFileSync(join(options.cwd!, "artifact-write-probe.json"), "utf8")), { writable: false, error: "EROFS" }, "the process must see the pinned package snapshot as read-only");

    await assert.rejects(client.callTool("raw", { text: "bypass" }), /not allowed|allowlist|not registered/i,
      "calling the unexposed tool directly must still be denied locally");
    assert.equal(existsSync(callsFile), false, "a denied direct call must never reach the MCP process");

    const result = await client.callTool("echo", { text: "allowed" });
    assert.equal(result.isError, false);
    assert.equal(readFileSync(callsFile, "utf8"), "1");
  } finally {
    await client.close();
  }
  assertServerStarted(pidFile);
});

test("registered MCP verifies the stored tree digest before spawning", async () => {
  const { options, pidFile } = fixture();
  const registered = registeredOptions(options);
  const artifact = registered.registration.artifact!;
  const storedEntrypoint = join(registered.artifactStoreRoot, artifact.digest.slice("sha256:".length), artifact.entrypoint);
  chmodSync(storedEntrypoint, 0o644);
  writeFileSync(storedEntrypoint, "process.exit(26);\n");
  await assert.rejects(connectRegisteredMcpServer(registered), /digest mismatch/);
  assert.equal(existsSync(pidFile), false, "a modified content-addressed tree must fail before spawn");
});

test("a registered MCP process cannot start without an absolute scratch HOME", async () => {
  const { options, pidFile } = fixture();
  const env: Record<string, string> = { ...options.env };
  delete env["HOME"];
  await assert.rejects(connectStdioMcpServer({ ...options, env }), /HOME/);
  assert.equal(existsSync(pidFile), false, "HOME validation must happen before spawning the server");
});

test("the process does not inherit a parent secret variable", async () => {
  const { options, pidFile, observedEnvFile, homeDir } = fixture();
  const envName = "SYNAPSER_MCP_TEST_INHERITED_SECRET";
  const previous = process.env[envName];
  process.env[envName] = "local-test-sentinel-not-a-credential";
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  try {
    client = await connectStdioMcpServer(options);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
  assert.deepEqual(JSON.parse(readFileSync(observedEnvFile, "utf8")), { home: homeDir, inheritedSecret: null });
  await client!.close();
  assertServerStarted(pidFile);
});

test("initialization notification is sent before tool discovery", async () => {
  const { options, handshakeFile } = fixture("handshake");
  const client = await connectStdioMcpServer(options);
  await client.listTools();
  assert.deepEqual(readFileSync(handshakeFile, "utf8").trim().split("\n"), [
    "notifications/initialized",
    "tools/list",
  ]);
  await client.close();
});

test("tool discovery follows pagination and aggregates unique tools", async () => {
  const { options, pidFile, cursorFile } = fixture("paginated");
  const client = await connectStdioMcpServer(options);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["page-one", "page-two"]);
  assert.deepEqual(readFileSync(cursorFile, "utf8").trim().split("\n"), ["<first>", "page-2"]);
  await client.close();
  assertServerStarted(pidFile);
});

test("tool discovery fails closed at its page bound", async () => {
  const { options, pidFile, cursorFile } = fixture("pagination-limit");
  options.timeoutMs = 20_000;
  options.callTimeoutMs = 20_000;
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /pagination limit|failed during tools\/list/);
  const pages = readFileSync(cursorFile, "utf8").trim().split("\n");
  assert.ok(pages.length > 0 && pages.length <= 100, `pagination must stop within 100 pages; saw ${pages.length}`);
  assertServerStarted(pidFile);
});

test("a schema keyword outside the supported subset rejects discovery and terminates the server", async () => {
  const { options, pidFile } = fixture("unsupported-schema");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /invalid advertised tool/);
  assertServerStarted(pidFile);
});

test("close kills a descendant that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("child-close");
  const client = await connectStdioMcpServer(options);
  await assertDescendantSpawned(grandchildPidFile);
  await client.close();
  assertServerStarted(pidFile);
  // close() returns only after systemd confirms the whole scope cgroup is empty, including the SIGTERM-resistant child.
});

test("timeout kills a descendant that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("child-timeout-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /timed out during tools\/list/);
  assertServerStarted(pidFile);
  await assertDescendantSpawned(grandchildPidFile);
  // The timed-out request does not reject until teardown has confirmed that the entire systemd scope is empty.
});

test("close terminates a detached descendant, not only the verified process group", { skip: process.platform !== "linux" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("detached-child-close");
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  try {
    client = await connectStdioMcpServer(options);
    const detached = await assertDescendantSpawned(grandchildPidFile);
    const server = JSON.parse(readFileSync(pidFile, "utf8")) as { pgid: number };
    assert.notEqual(detached["pgid"], server.pgid, "the detached child must escape the server's process group");

    await client.close();
    client = undefined;
    assertServerStarted(pidFile);
    // The child PID is namespace-local; the verified empty cgroup is the authority that it has terminated.
  } finally {
    if (client) await client.close();
  }
});

test("an outbound MCP process joins the workflow memory slice and retains its per-process ceilings", { skip: process.platform !== "linux" }, async () => {
  const { options, pidFile, resourceLimitsFile } = fixture();
  const scope = new RunMemoryScope();
  assert.match(scope.unit, /^synapser-run-[0-9a-f]{32}\.slice$/);
  const parentSlice = await scope.ensure();
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  try {
    client = await connectStdioMcpServer({ ...options, parentSlice });
    const limits = JSON.parse(readFileSync(resourceLimitsFile, "utf8")) as { relative: string; memoryMax: string; pidsMax: string };
    const parent = spawnSync("systemctl", ["--user", "show", parentSlice, "--property=ControlGroup"], { encoding: "utf8" });
    assert.equal(parent.status, 0);
    const parentCgroup = String(parent.stdout).trim().slice("ControlGroup=".length);
    assert.ok(limits.relative.startsWith(`${parentCgroup}/`), `MCP cgroup ${limits.relative} must be nested beneath workflow cgroup ${parentCgroup}`);
    assert.equal(limits.memoryMax, String(4 * 1024 * 1024 * 1024), "effective cgroup memory.max must preserve the per-process ceiling");
    assert.equal(limits.pidsMax, "64", "effective cgroup pids.max must enforce the per-server 64-task limit");
  } finally {
    if (client) await client.close();
    await scope.close();
  }
  assertServerStarted(pidFile);
});

test("an outbound MCP process cannot read a sibling host file outside its registered workspace", { skip: process.platform !== "linux" }, async () => {
  const { options, dir, pidFile } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "synapser-mcp-outside-"));
  dirs.push(outside);
  const secret = join(outside, "host-only-sentinel.txt");
  writeFileSync(secret, "HOST-FILESYSTEM-SENTINEL");
  options.env.HOST_PROBE_PATH = secret;
  const client = await connectStdioMcpServer(options);
  try {
    const probe = JSON.parse(readFileSync(join(dir, "external-read.json"), "utf8")) as { content?: string; error?: string };
    assert.equal(probe.content, undefined, "host file contents must not cross the bwrap filesystem boundary");
    assert.ok(probe.error, "the host-only path should be inaccessible from the server namespace");
  } finally {
    await client.close();
  }
  assertServerStarted(pidFile);
});

test("an outbound MCP process cannot see a same-UID host process through /proc", { skip: process.platform !== "linux" }, async () => {
  const sentinel = `controlled-fixture-${process.pid}-${Date.now()}`;
  const hostProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { PATH: process.env["PATH"] ?? "", SYNAPSER_FIXTURE_SENTINEL: sentinel },
    stdio: "ignore",
  });
  assert.ok(hostProcess.pid, "the host sentinel process has a PID");
  const hostPid = hostProcess.pid!;
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  try {
    // Establish the fixture is real and readable from its host parent before testing the sandbox boundary.
    const hostEnvironment = readFileSync(`/proc/${hostPid}/environ`, "utf8").split("\0");
    assert.ok(hostEnvironment.includes(`SYNAPSER_FIXTURE_SENTINEL=${sentinel}`), "the selected host process exposes only this test-controlled sentinel");

    const { options, dir } = fixture();
    const probeFile = join(dir, "pid-probe.json");
    options.env.HOST_PROBE_PID = String(hostPid);
    options.env.HOST_PROBE_SENTINEL = sentinel;
    options.env.PID_PROBE_FILE = probeFile;
    client = await connectStdioMcpServer(options);
    const probe = JSON.parse(readFileSync(probeFile, "utf8")) as { visible: boolean; sentinelPresent?: boolean; error?: string };
    assert.equal(probe.visible, false, "the host PID must be absent in the outbound process's private PID namespace");
    assert.notEqual(probe.sentinelPresent, true, "the MCP process must not read the controlled host environment");
    await client.close();
    client = undefined;
    // `close()` is the stronger registered-process contract: it returns only after systemd confirms the scope is empty.
  } finally {
    if (client) await client.close();
    if (hostProcess.exitCode === null && hostProcess.signalCode === null) hostProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (hostProcess.exitCode !== null || hostProcess.signalCode !== null) return resolve();
      hostProcess.once("exit", () => resolve());
      setTimeout(() => {
        if (hostProcess.exitCode === null && hostProcess.signalCode === null) hostProcess.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
  }
});

test("an outbound MCP process cannot connect to a host-local listener", { skip: process.platform !== "linux" }, async () => {
  const net = await import("node:net");
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const { options, dir, pidFile } = fixture();
  options.env.NETWORK_PROBE_PORT = String(address.port);
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  try {
    client = await connectStdioMcpServer(options);
    const probePath = join(dir, "network-probe.json");
    for (let attempt = 0; attempt < 30 && !existsSync(probePath); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(probePath), "fixture recorded the loopback probe result");
    const probe = JSON.parse(readFileSync(probePath, "utf8")) as { connected: boolean };
    assert.equal(probe.connected, false, "the server should have no route to host loopback");
  } finally {
    if (client) await client.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  assertServerStarted(pidFile);
});

test("tool-level isError is preserved for the caller", async () => {
  const { options, pidFile } = fixture("tool-error");
  const client = await connectStdioMcpServer(options);
  const result = await client.callTool("echo", { text: "input" });
  assert.deepEqual(result, { content: [{ type: "text", text: "expected tool failure" }], isError: true });
  await client.close();
  assertServerStarted(pidFile);
});

test("invalid tool content fails closed and terminates the server", async () => {
  const { options, pidFile } = fixture("invalid-content");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.callTool("echo", { text: "input" }), /failed during tools\/call/);
  assertServerStarted(pidFile);
});

test("structured tool output is validated against the advertised output schema", async () => {
  const { options, pidFile } = fixture("output-schema-good");
  const client = await connectStdioMcpServer(options);
  const result = await client.callTool("echo", {});
  assert.deepEqual(result.structuredContent, { result: "ok" });
  await client.close();
  assertServerStarted(pidFile);
});

test("structured tool output violating outputSchema fails closed", async () => {
  const { options, pidFile } = fixture("output-schema-invalid");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.callTool("echo", {}), /failed during tools\/call/);
  assertServerStarted(pidFile);
});
