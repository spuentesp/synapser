// Opt-in proof for plan 15, alternative B. This launches the installed Claude CLI only against a local HTTPS
// fixture; it never loads operator credentials or contacts a public provider.
//
// Invariants: bwrap creates a network namespace with no default route; the CLI gets a fresh HOME and an empty
// environment except for a dummy key and the local fixture/proxy settings. The checkout and real HOME (including
// `.env`) are hidden. The host-side CONNECT proxy forwards
// exactly fixture.test:<ephemeral-port>; all other authorities receive 403. Direct IP and DNS probes run in the
// same namespace and must fail. Only this fixture is mounted/reachable through the proxy.
// Verifier: SYNAPSER_P159_LOCAL_PROXY=1 node --test test/live/p159-network-proxy.test.ts
// Falsification: remove --unshare-net, allow a second CONNECT authority, or bypass the proxy and one of the
// negative probes / deny assertions below must stop proving the boundary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { test } from "node:test";

const enabled = process.env["SYNAPSER_P159_LOCAL_PROXY"] === "1";
const timeoutMs = 150_000;
const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

function commandExists(file: string): boolean {
  return (process.env["PATH"] ?? "").split(":").some((directory) => existsSync(join(directory, file)));
}

function findExecutable(file: string): string | undefined {
  return (process.env["PATH"] ?? "").split(":").map((directory) => join(directory, file)).find(existsSync);
}

async function listen(server: { listen: (port: number, host: string, cb: () => void) => unknown }, host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    server.listen(0, host, () => {
      const address = (server as any).address();
      if (!address || typeof address === "string") reject(new Error("fixture did not bind TCP"));
      else resolvePort(address.port as number);
    });
    (server as any).once("error", reject);
  });
}

function runChild(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out: ${stderr.slice(-3000)}`)); }, options.timeout ?? 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
  });
}

test("P15.9 local allowlist proxy contains the real Claude CLI", { skip: enabled ? false : "set SYNAPSER_P159_LOCAL_PROXY=1 to opt into the isolated local CLI proof", timeout: timeoutMs }, async (t) => {
  assert.equal(process.platform, "linux", "bwrap network namespaces require Linux");
  for (const executable of ["bwrap", "openssl", "claude", "node"]) assert.ok(commandExists(executable), `required local executable missing: ${executable}`);

  const scratch = await mkdtemp(join(tmpdir(), "synapser-p159-proxy-"));
  const socketDir = join(scratch, "proxy");
  const socketPath = join(socketDir, "egress.sock");
  await mkdir(socketDir, { recursive: true });
  const certPath = join(socketDir, "fixture.crt");
  const keyPath = join(socketDir, "fixture.key");
  const { stdout: opensslOut, stderr: opensslErr, code: opensslCode } = await runChild("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=fixture.test", "-addext", "subjectAltName=DNS:fixture.test", "-addext", "basicConstraints=critical,CA:TRUE",
  ], { timeout: 20_000 });
  assert.equal(opensslCode, 0, `could not create local-only fixture certificate: ${opensslErr || opensslOut}`);
  const tlsKey = await readFile(keyPath);
  const tlsCert = await readFile(certPath);
  const received: string[] = [];
  const fixture = createHttpsServer({ key: tlsKey, cert: tlsCert }, (request, response) => {
    received.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_local","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"local-fixture-answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""));
  });
  let proxy: ReturnType<typeof createNetServer> | undefined;
  let bwrap: ReturnType<typeof spawn> | undefined;
  let processGroup: number | undefined;
  try {
    const fixturePort = await listen(fixture);
    assert.notEqual(fixturePort, 43129, "avoid colliding with the namespace-local proxy shim port");
    proxy = createNetServer((client) => {
      let header = Buffer.alloc(0);
      client.on("data", function onHeader(chunk) {
        header = Buffer.concat([header, chunk]);
        const boundary = header.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        client.off("data", onHeader);
        const firstLine = header.subarray(0, boundary).toString("latin1").split("\r\n", 1)[0] ?? "";
        const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(firstLine);
        const allowedAuthority = `fixture.test:${fixturePort}`;
        if (!match || match[1] !== allowedAuthority) {
          client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const upstream = connectNet(fixturePort, "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remainder = header.subarray(boundary + 4);
          if (remainder.length) upstream.write(remainder);
          client.pipe(upstream).pipe(client);
        });
        upstream.on("error", () => client.destroy());
      });
      client.on("error", () => undefined);
    });
    await new Promise<void>((resolveListen, reject) => {
      proxy!.listen(socketPath, resolveListen).once("error", reject);
    });

    // A tiny namespace-local TCP shim lets ordinary HTTPS_PROXY clients reach the host proxy over a mounted Unix
    // socket. It is async (not spawnSync), so CONNECT traffic is serviced while the CLI runs.
    const bridgeSource = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const socketPath = process.env.P15_PROXY_SOCKET;
const proxyPort = 43129;
const bridge = net.createServer((client) => {
  const upstream = net.createConnection(socketPath);
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
bridge.listen(proxyPort, '127.0.0.1', async () => {
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.P15_DIRECT_PORT) });
      socket.setTimeout(1500);
      socket.once('connect', () => { socket.destroy(); reject(new Error('direct loopback unexpectedly connected')); });
      socket.once('error', resolve);
      socket.once('timeout', () => { socket.destroy(); resolve(); });
    });
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '203.0.113.1', port: 443 });
      socket.setTimeout(1500);
      socket.once('connect', () => { socket.destroy(); reject(new Error('direct public-IP connection unexpectedly connected')); });
      socket.once('error', resolve);
      socket.once('timeout', () => { socket.destroy(); resolve(); });
    });
    await new Promise((resolve, reject) => require('node:dns').lookup('example.com', (error) => error ? resolve() : reject(new Error('direct DNS unexpectedly resolved'))));
    if (process.env.P15_EXPECT_ENV === '1' && require('node:fs').existsSync(process.env.P15_CHECKOUT + '/.env')) throw new Error('operator .env is visible in the sandbox');
    const denied = await new Promise((resolve, reject) => {
      const request = net.createConnection(proxyPort, '127.0.0.1', () => request.write('CONNECT denied.test:443 HTTP/1.1\r\nHost: denied.test:443\r\n\r\n'));
      let data = ''; request.setTimeout(3000, () => { request.destroy(); reject(new Error('denied CONNECT timed out')); });
      request.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\r\n\r\n')) { request.destroy(); resolve(data); } });
      request.on('error', (error) => { if (data) resolve(data); else reject(error); });
    });
    if (!String(denied).startsWith('HTTP/1.1 403')) throw new Error('proxy did not deny non-allowlisted CONNECT: ' + denied);
    const home = '/tmp/p15-claude-home'; require('node:fs').mkdirSync(home, { recursive: true });
    const child = spawn(process.env.P15_CLAUDE, ['-p', 'Reply with the exact text local-fixture-answer.', '--output-format', 'text', '--model', 'claude-sonnet-4-5', '--no-session-persistence'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: home, PATH: process.env.P15_PATH, TMPDIR: '/tmp',
        ANTHROPIC_API_KEY: 'synapser-local-dummy-key', ANTHROPIC_BASE_URL: 'https://fixture.test:' + process.env.P15_DIRECT_PORT,
        ANTHROPIC_MODEL: 'claude-sonnet-4-5', HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort, HTTP_PROXY: 'http://127.0.0.1:' + proxyPort,
        https_proxy: 'http://127.0.0.1:' + proxyPort, http_proxy: 'http://127.0.0.1:' + proxyPort,
        NODE_EXTRA_CA_CERTS: process.env.P15_CERT, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      },
    });
    let stdout = '', stderr = ''; child.stdout.on('data', (d) => stdout += d); child.stderr.on('data', (d) => stderr += d);
    const timer = setTimeout(() => child.kill('SIGTERM'), 100000);
    const code = await new Promise((resolve) => child.once('close', resolve)); clearTimeout(timer);
    process.stdout.write(JSON.stringify({ code, stdout, stderr }));
    process.exitCode = code === 0 && stdout.includes('local-fixture-answer') ? 0 : 42;
  } catch (error) { console.error(error); process.exitCode = 41; }
  finally { bridge.close(); }
});`;

    const nodeBin = resolve(process.execPath);
    const nodeRoot = dirname(dirname(nodeBin));
    const claudePath = findExecutable("claude");
    assert.ok(claudePath, "Claude CLI is not on PATH");
    const claudeBin = await realpath(claudePath);
    await access(claudeBin);
    const args = [
      "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--tmpfs", "/tmp", "--tmpfs", "/opt", "--dir", "/opt/claude-node", "--ro-bind", nodeRoot, "/opt/claude-node",
      "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", resolve(process.cwd()),
      "--tmpfs", "/run", "--dir", "/run/p15", "--ro-bind", socketDir, "/run/p15",
      "--chdir", "/tmp", "--", "/opt/claude-node/bin/node", "-e", bridgeSource,
    ];
    const path = "/opt/claude-node/bin:/usr/bin:/bin";
    const hostEnvExists = await access(join(resolve(process.cwd()), ".env")).then(() => true, () => false);
    bwrap = spawn("bwrap", args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"],
        P15_PROXY_SOCKET: "/run/p15/egress.sock", P15_DIRECT_PORT: String(fixturePort),
        P15_CLAUDE: claudeBin.replace(nodeRoot, "/opt/claude-node"), P15_PATH: path,
        P15_CERT: "/run/p15/fixture.crt", P15_CHECKOUT: resolve(process.cwd()), P15_EXPECT_ENV: hostEnvExists ? "1" : "0",
      },
    });
    processGroup = bwrap.pid;
    let stdout = "";
    let stderr = "";
    assert.ok(bwrap.stdout && bwrap.stderr);
    bwrap.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    bwrap.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error(`bwrap/Claude timed out; stderr: ${stderr.slice(-4000)}`)), timeoutMs - 5_000);
      bwrap!.once("error", (error) => { clearTimeout(timer); reject(error); });
      bwrap!.once("close", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
    });
    assert.equal(result.code, 0, `isolated CLI failed (${result.signal ?? result.code}): ${stderr.slice(-4000)} ${stdout.slice(-1000)}`);
    assert.ok(received.some((request) => request.startsWith("POST /v1/messages")), `fixture received no Claude messages request: ${received.join(", ")}`);
    assert.ok(received.length > 0);
  } finally {
    if (processGroup) {
      try { process.kill(-processGroup, "SIGTERM"); } catch { /* process already exited */ }
      await delay(300);
      try { process.kill(-processGroup, "SIGKILL"); } catch { /* process already exited */ }
    }
    if (proxy) await new Promise<void>((resolveClose) => proxy!.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  }
});
