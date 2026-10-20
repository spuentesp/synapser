import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EffectBroker, type EffectRecord } from "../../src/effects/broker.ts";
import { BUILTIN_KINDS } from "../../src/effects/kinds.ts";
import { mcpCallKind } from "../../src/effects/mcp-call.ts";
import type { Policy } from "../../src/effects/policy.ts";
import { importMcpArtifact } from "../../src/mcp/artifact-store.ts";
import { type McpServerRegistration, validateMcpServerRegistry } from "../../src/mcp/registry.ts";
import { Journal } from "../../src/journal/journal.ts";
import { decideApproval } from "../../src/orchestration/gates.ts";

// Plan 19 RCP6h: an operator-declared MCP effect tool runs only through the broker, after an approval bound to the
// whole registration. The fixture is a real pinned MCP stdio server; its result reports what it received.
const R = "run-mcp-effect";

describe("plan 19 RCP6h: operator-declared MCP effect tools through the broker", () => {
  let dir: string;
  let servers: McpServerRegistration[];
  let journal: Journal;
  let policy: Policy;
  let clock = 1_000_000;
  let broker: EffectBroker;


  const mkBroker = (env: NodeJS.ProcessEnv = {}) => {
    broker = new EffectBroker({
      journal,
      runId: R,
      repoRoot: dir,
      policy: () => policy,
      now: () => clock,
      env,
      kinds: [...BUILTIN_KINDS, mcpCallKind({ registrations: () => servers, artifactStoreRoot: join(dir, "artifact-store") })],
    });
    return broker;
  };

  const approve = (id: string) => {
    const rec = broker.status(id)!;
    return decideApproval(journal, R, { taskId: `effect:${id}`, planDigest: rec.digest, currentDigest: rec.digest, decision: "APPROVED", actor: "ana", channel: "cli" } as never);
  };

  const sendMail = (to: string) => ({ server: "mail", tool: "send_mail", arguments: { to } });
  const askSendMail = (): Policy => ({ version: 1, default: "deny", rules: [{ id: "ask-mail", kind: "mcp.call", params: { server: "mail" }, decision: "ask" }] });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-effect-")));
    const packageRoot = join(dir, "package");
    mkdirSync(packageRoot);
    // The fixture is a plain JSON-RPC stdio server. It cannot write files (the sandbox confines it), so it reports in its result.
    writeFileSync(join(packageRoot, "server.cjs"), [
      "let input = '';",
      "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const line = input.slice(0, i); input = input.slice(i + 1); const request = JSON.parse(line);",
      "  if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'effect-fixture', version: '1' } });",
      "  else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }, { name: 'send_mail', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false } }] });",
      "  else if (request.method === 'tools/call') reply(request.id, { content: [{ type: 'text', text: 'sent to ' + request.params.arguments.to + ' env:' + Object.keys(process.env).sort().join(',') }] });",
      "  else if (request.id !== undefined) reply(request.id, {});",
      "} });",
    ].join("\n"));
    const artifact = importMcpArtifact(packageRoot, join(dir, "artifact-store"));
    const parsed = validateMcpServerRegistry([{
      id: "mail",
      enabled: true,
      origin: "file:///tmp/effect-fixture",
      version: "1.0.0",
      command: process.execPath,
      args: [],
      artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
      expectedServer: { name: "effect-fixture", version: "1" },
      profiles: { "nemotron-worker": ["inspect", "send_mail"] },
      effectTools: ["send_mail"],
    }], ["nemotron-worker"], ["nemotron-worker"]);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    servers = parsed.servers;
    journal = Journal.open(join(dir, "state"), R);
    policy = askSendMail();
    mkBroker();
  });
  afterEach(() => {
    journal.close();
    // the artifact store is read-only by design: make it writable again before removing it
    const makeWritable = (path: string): void => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) makeWritable(join(path, name));
    };
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("default deny: without a rule the call is DENIED and no server process starts", async () => {
    policy = { version: 1, default: "deny", rules: [] };
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("ana@example.com") });
    assert.equal(r.ok && r.state, "DENIED");
    await broker.tick();
    assert.equal(broker.status(r.ok ? r.id : "")!.state, "DENIED");
  });

  test("ask: PENDING until a human approves, then the server gets exactly the approved arguments once", async () => {
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("ana@example.com") });
    assert.equal(r.ok && r.state, "PENDING");
    await broker.tick();
    assert.equal(broker.status(r.ok ? r.id : "")!.state, "PENDING");
    assert.equal(approve(r.ok ? r.id : "").ok, true);
    await broker.tick();
    const rec = broker.status(r.ok ? r.id : "") as EffectRecord;
    assert.equal(rec.state, "DONE", rec.reason ?? undefined);
    assert.equal(rec.evidence?.["trust"], "UNTRUSTED_MCP_DATA", "the output is marked as data, not instructions");
    assert.match(String(rec.evidence?.["output"]), /sent to ana@example\.com/);
  });

  test("a registration changed after approval is STALE and the call never runs", async () => {
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("ana@example.com") });
    const id = r.ok ? r.id : "";
    approve(id);
    // the operator re-registers the same server with different args: the approval no longer describes it
    servers = [{ ...servers[0]!, args: ["--changed"] }];
    await broker.tick();
    assert.equal(broker.status(id)!.state, "STALE");
    assert.equal(broker.status(id)!.evidence, null, "a stale effect ran nothing");
  });

  test("a disabled server fails before it starts, even when the effect was requested", async () => {
    servers = [{ ...servers[0]!, enabled: false }];
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("ana@example.com") });
    assert.equal(broker.status(r.ok ? r.id : "")!.state, "FAILED");
    assert.match(broker.status(r.ok ? r.id : "")!.reason ?? "", /MCP_SERVER_DISABLED/);
  });

  test("a tool that is not declared an effect, and an unknown server, fail before anything starts", async () => {
    // a kind-wide ask rule, so these requests reach the live checks instead of stopping at the policy
    policy = { version: 1, default: "deny", rules: [{ id: "ask-any", kind: "mcp.call", decision: "ask" }] };
    const notEffect = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: { server: "mail", tool: "inspect", arguments: {} } });
    assert.match(broker.status(notEffect.ok ? notEffect.id : "")!.reason ?? "", /MCP_TOOL_NOT_EFFECT/);
    const unknown = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: { server: "ghost", tool: "send_mail", arguments: {} } });
    assert.match(broker.status(unknown.ok ? unknown.id : "")!.reason ?? "", /UNKNOWN_MCP_SERVER/);
  });

  test("the server runs without the broker's environment: a credential in the broker's env never reaches it", async () => {
    mkBroker({ SYNAPSER_BROKER_SECRET: "must-not-leak", HOME: "/broker/home" });
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("ana@example.com") });
    approve(r.ok ? r.id : "");
    await broker.tick();
    assert.equal(broker.status(r.ok ? r.id : "")!.state, "DONE");
    const env = String(broker.status(r.ok ? r.id : "")!.evidence?.["output"]).split("env:")[1] ?? "";
    assert.equal(env.includes("SYNAPSER_BROKER_SECRET"), false, "the broker's credential is not in the server's environment");
  });

  test("the output is bounded before it reaches the ledger, and oversized arguments are refused at validation", async () => {
    const long = "x".repeat(5_000);
    const r = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail(long) });
    approve(r.ok ? r.id : "");
    await broker.tick();
    const rec = broker.status(r.ok ? r.id : "") as EffectRecord;
    assert.equal(rec.state, "DONE");
    assert.equal(rec.evidence?.["truncated"], true);
    assert.ok(String(rec.evidence?.["output"]).length <= 4_000);
    const tooLarge = await broker.request({ kind: "mcp.call", requestedBy: "worker", params: sendMail("x".repeat(21_000)) });
    assert.equal(tooLarge.ok, false);
  });
});
