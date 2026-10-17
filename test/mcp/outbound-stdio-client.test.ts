import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { connectStdioMcpServer } from "../../src/mcp/outbound-stdio-client.ts";

// This is an actual child process speaking MCP's newline-delimited JSON-RPC protocol. It is intentionally
// small enough to make the adversarial wire cases explicit instead of relying on an in-process server double.
const SERVER = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const net = require('node:net');
const mode = process.env.TEST_MODE || 'normal';
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.OBSERVED_ENV_FILE) fs.writeFileSync(process.env.OBSERVED_ENV_FILE, JSON.stringify({ home: process.env.HOME || null, inheritedSecret: process.env.SYNAPSER_MCP_TEST_INHERITED_SECRET || null }));
if (process.env.RESOURCE_LIMITS_FILE) {
  const entry = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
  const relative = entry ? entry.slice(3) : null;
  const root = relative === null ? null : '/sys/fs/cgroup' + relative;
  const read = name => root === null ? null : fs.readFileSync(root + '/' + name, 'utf8').trim();
  fs.writeFileSync(process.env.RESOURCE_LIMITS_FILE, JSON.stringify({ relative, memoryMax: read('memory.max'), pidsMax: read('pids.max') }));
}
if (process.env.HOST_PROBE_PATH) {
  try { fs.writeFileSync('external-read.json', JSON.stringify({ content: fs.readFileSync(process.env.HOST_PROBE_PATH, 'utf8') })); }
  catch (error) { fs.writeFileSync('external-read.json', JSON.stringify({ error: error.code || error.message })); }
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
      if (process.env.GRANDCHILD_PID_FILE) fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));
    }
    if (mode === 'detached-child-close') {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: true });
      if (process.env.GRANDCHILD_PID_FILE) fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));
    }
    if (mode === 'coalesced-invalid') {
      const init = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'x'.repeat(120), version: '1' } } });
      const unsolicited = JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} });
      if (process.env.FRAME_LENGTHS_FILE) fs.writeFileSync(process.env.FRAME_LENGTHS_FILE, Buffer.byteLength(init) + ' ' + Buffer.byteLength(unsolicited) + ' ' + Buffer.byteLength(init + '\n' + unsolicited + '\n'));
      process.stdout.write(init + '\n' + unsolicited + '\n');
      return;
    }
    reply(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: mode === 'bad-identity' ? { name: 'local-fixture' } : { name: 'local-fixture', version: '1' } });
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

async function assertChildReaped(pidFile: string): Promise<void> {
  assert.ok(existsSync(pidFile), "fixture recorded its child PID");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`MCP child ${pid} remained alive after client cleanup`);
}

async function assertPidNotRunning(pidFile: string): Promise<void> {
  assert.ok(existsSync(pidFile), "fixture recorded the process PID");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
      // A killed descendant can briefly remain as a zombie until the host init reaps it; it is no longer running.
      if (process.platform === "linux") {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
          if (state === "Z") return;
        } catch { return; }
      }
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} remained running after client cleanup`);
}

function linuxProcessGroup(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const pgid = Number(fields[2]);
  assert.ok(Number.isSafeInteger(pgid) && pgid > 1, `could not read process group for PID ${pid}`);
  return pgid;
}

async function assertPidRunning(pidFile: string): Promise<number> {
  assert.ok(existsSync(pidFile), "fixture recorded the process PID");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      process.kill(pid, 0);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (state !== "Z") return pid;
    } catch {
      // The child may not have finished spawning yet; retry briefly before failing.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} did not remain running after process-group cleanup`);
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
  await assertChildReaped(pidFile);
});

test("malformed response frames fail closed and reap the child", async () => {
  const { options, pidFile } = fixture("malformed");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  await assertChildReaped(pidFile);
});

test("oversized response frames fail closed and reap the child", async () => {
  const { options, pidFile } = fixture("oversized");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  await assertChildReaped(pidFile);
});

test("coalesced frames are subject to the SDK's accumulated-buffer limit", async () => {
  const { options, pidFile, frameLengthsFile } = fixture("coalesced-invalid");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  const [first, second, combined] = readFileSync(frameLengthsFile, "utf8").trim().split(" ").map(Number);
  assert.ok(first! < 256);
  assert.ok(second! < 256);
  assert.ok(combined! > 256);
  await assertChildReaped(pidFile);
});

test("a timed-out request poisons the session and reaps the child", async () => {
  const { options, pidFile } = fixture("timeout-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /timed out during tools\/list/);
  await assertChildReaped(pidFile);
});

test("a server exit during an outstanding request rejects and closes the session", async () => {
  const { options, pidFile } = fixture("exit-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /failed during tools\/list/);
  await assertChildReaped(pidFile);
});

test("a server exit during initialization is reported without leaking its process", async () => {
  const { options, pidFile } = fixture("exit-init");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  await assertChildReaped(pidFile);
});

test("server identity must include both name and version", async () => {
  const { options, pidFile } = fixture("bad-identity");
  await assert.rejects(connectStdioMcpServer(options), /failed initialization or process-group verification/);
  await assertChildReaped(pidFile);
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
  await assertChildReaped(pidFile);
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
  await assertChildReaped(pidFile);
});

test("tool discovery fails closed at its page bound", async () => {
  const { options, pidFile, cursorFile } = fixture("pagination-limit");
  options.timeoutMs = 20_000;
  options.callTimeoutMs = 20_000;
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /pagination limit|failed during tools\/list/);
  const pages = readFileSync(cursorFile, "utf8").trim().split("\n");
  assert.ok(pages.length > 0 && pages.length <= 100, `pagination must stop within 100 pages; saw ${pages.length}`);
  await assertChildReaped(pidFile);
});

test("a schema keyword outside the supported subset rejects discovery and terminates the server", async () => {
  const { options, pidFile } = fixture("unsupported-schema");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /invalid advertised tool/);
  await assertChildReaped(pidFile);
});

test("close kills a descendant that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("child-close");
  const client = await connectStdioMcpServer(options);
  await client.close();
  await assertChildReaped(pidFile);
  await assertPidNotRunning(grandchildPidFile);
});

test("timeout kills a descendant that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("child-timeout-list");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.listTools(), /timed out during tools\/list/);
  await assertChildReaped(pidFile);
  await assertPidNotRunning(grandchildPidFile);
});

test("close terminates a detached descendant, not only the verified process group", { skip: process.platform !== "linux" }, async () => {
  const { options, pidFile, grandchildPidFile } = fixture("detached-child-close");
  let client: Awaited<ReturnType<typeof connectStdioMcpServer>> | undefined;
  let detachedPid: number | undefined;
  try {
    client = await connectStdioMcpServer(options);
    detachedPid = await assertPidRunning(grandchildPidFile);
    const serverPid = Number(readFileSync(pidFile, "utf8"));
    assert.notEqual(linuxProcessGroup(detachedPid), linuxProcessGroup(serverPid), "detached child must escape the server's verified process group");

    await client.close();
    client = undefined;
    await assertChildReaped(pidFile);
    await assertPidNotRunning(grandchildPidFile);
  } finally {
    if (client) {
      try { await client.close(); } catch { /* cleanup below explicitly reaps the detached test process */ }
    }
    if (detachedPid === undefined && existsSync(grandchildPidFile)) detachedPid = Number(readFileSync(grandchildPidFile, "utf8"));
    if (detachedPid !== undefined && Number.isSafeInteger(detachedPid) && detachedPid > 1) {
      try { process.kill(detachedPid, "SIGKILL"); } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      }
      await assertPidNotRunning(grandchildPidFile);
    }
  }
});

test("an outbound MCP process is placed under the 4 GiB and 64-task cgroup ceiling", { skip: process.platform !== "linux" }, async () => {
  const { options, pidFile, resourceLimitsFile } = fixture();
  const client = await connectStdioMcpServer(options);
  try {
    const limits = JSON.parse(readFileSync(resourceLimitsFile, "utf8")) as { memoryMax: string; pidsMax: string };
    assert.equal(limits.memoryMax, String(4 * 1024 * 1024 * 1024), "effective cgroup memory.max must enforce the approved aggregate 4 GiB limit");
    assert.equal(limits.pidsMax, "64", "effective cgroup pids.max must enforce the per-server 64-task limit");
  } finally {
    await client.close();
  }
  await assertChildReaped(pidFile);
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
  await assertChildReaped(pidFile);
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
  await assertChildReaped(pidFile);
});

test("tool-level isError is preserved for the caller", async () => {
  const { options, pidFile } = fixture("tool-error");
  const client = await connectStdioMcpServer(options);
  const result = await client.callTool("echo", { text: "input" });
  assert.deepEqual(result, { content: [{ type: "text", text: "expected tool failure" }], isError: true });
  await client.close();
  await assertChildReaped(pidFile);
});

test("invalid tool content fails closed and terminates the server", async () => {
  const { options, pidFile } = fixture("invalid-content");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.callTool("echo", { text: "input" }), /failed during tools\/call/);
  await assertChildReaped(pidFile);
});

test("structured tool output is validated against the advertised output schema", async () => {
  const { options, pidFile } = fixture("output-schema-good");
  const client = await connectStdioMcpServer(options);
  const result = await client.callTool("echo", {});
  assert.deepEqual(result.structuredContent, { result: "ok" });
  await client.close();
  await assertChildReaped(pidFile);
});

test("structured tool output violating outputSchema fails closed", async () => {
  const { options, pidFile } = fixture("output-schema-invalid");
  const client = await connectStdioMcpServer(options);
  await assert.rejects(client.callTool("echo", {}), /failed during tools\/call/);
  await assertChildReaped(pidFile);
});
