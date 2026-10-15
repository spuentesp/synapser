import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import { StdioClient } from "./stdio-client.ts";

// H7.4: a config change made through mcp-config is consumed by a NEW task MCP process. The
// planner and injected Codex CLI both call a local OpenAI-compatible endpoint; no external API
// or credential is involved. The runner's real journal is inspected for K4 injection evidence.
const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const TOKEN = "e2e-operator-token-sentinel-0123456789abcdef";
const HOT_KEY = "e2e-provider-key-sentinel-never-a-real-key";
const MODEL = "hot-model";
const ZOO = process.env["ZOANTHROPE_BIN"] ?? "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const json = (body: unknown) => JSON.stringify(body);

test("H7.4 mcp-config changes a provider and a new MCP task process uses it, recorded in the K4 ledger", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-cfg-task-"));
  const workspace = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const configPath = join(dir, "synapser.config.json");
  const binDir = join(dir, "bin");
  mkdirSync(workspace);
  mkdirSync(binDir);
  writeFileSync(join(workspace, "README.md"), "before\n");

  const requests: { path: string; authorization: string | undefined; model: string | undefined; messages: unknown }[] = [];
  const modelServer: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: unknown[] };
    requests.push({ path: req.url ?? "", authorization: req.headers.authorization, model: body.model, messages: body.messages });
    res.setHeader("content-type", "application/json");
    const plan = {
      tasks: [{ id: "edit-readme", objective: "Append a line", scope: ["README.md"], criteria: ["README has the requested line"], deps: [], serves: ["readme-changed"], profile: "codex-hot" }],
    };
    res.end(json({ id: "local-response", choices: [{ message: { role: "assistant", content: json(plan) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = (modelServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${modelPort}/changed/v1/`;
  const initialUrl = `http://127.0.0.1:${modelPort}/old/v1/`;
  const oldProvider = { protocol: "openai-compatible", baseUrl: initialUrl, apiKeyEnv: ["HOT_KEY"], models: [{ id: MODEL }] };
  const changedProvider = { ...oldProvider, baseUrl };
  const config = {
    workspace, stateDir, profiles: ["codex-writer"],
    providers: { hot: oldProvider },
    roles: { supervisor: { provider: "hot", model: MODEL, temperature: 0 } },
    agents: [{ id: "codex-hot", extends: "codex-writer", injectProvider: "hot", model: MODEL }],
  };
  writeFileSync(configPath, JSON.stringify(config));

  // This executable stands in for Codex itself. It consumes the injected config arguments and
  // key, makes a real local HTTP request, edits only its isolated working copy, then emits the
  // Codex JSONL success events understood by the production adapter.
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const config = process.argv.find((arg) => arg.startsWith('model_providers.hot='));
if (!config || !process.env.HOT_KEY) process.exit(31);
const match = /base_url=("(?:\\\\.|[^"\\\\])*")/.exec(config);
if (!match) process.exit(32);
const baseUrl = JSON.parse(match[1]);
const response = await fetch(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'), {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.HOT_KEY },
  body: JSON.stringify({ model: 'hot-model', messages: [{ role: 'user', content: 'fake codex agent request' }] }),
});
if (!response.ok) process.exit(33);
appendFileSync('README.md', 'after from injected provider\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(codexPath, 0o755);

  let api: ChildProcess | undefined;
  let configClient: StdioClient | undefined;
  let taskClient: StdioClient | undefined;
  let apiUrl: string | undefined;
  try {
    const apiPort = await freePort();
    apiUrl = `http://127.0.0.1:${apiPort}`;
    api = spawn(process.execPath, [CLI, "serve", "--port", String(apiPort), "--config", configPath], {
      cwd: dir,
      env: { ...process.env, SYNAPSER_OPERATOR_TOKEN: TOKEN, HOT_KEY, ZOANTHROPE_BIN: ZOO, PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}` },
      stdio: "ignore",
    });
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      try { if ((await fetch(`${apiUrl}/api/session`)).ok) break; } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok((await fetch(`${apiUrl}/api/session`)).ok, "operator API started");

    configClient = new StdioClient(dir, ["mcp-config"], { SYNAPSER_API_URL: apiUrl, SYNAPSER_OPERATOR_TOKEN: TOKEN });
    await configClient.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "config-e2e", version: "1" } });
    configClient.notify("notifications/initialized");
    const put = await configClient.request("tools/call", { name: "config_put_provider", arguments: { id: "hot", provider: changedProvider } });
    const putText = ((put["result"] as { content: { text: string }[] }).content[0]?.text) ?? "";
    assert.match(putText, /200/, putText);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).providers.hot.baseUrl, baseUrl, "provider change persisted to the operator file");
    await configClient.close();
    configClient = undefined;

    // Deliberately launch a different MCP process after the persisted config change.
    taskClient = new StdioClient(dir, ["mcp", "--config", configPath], { HOT_KEY, ZOANTHROPE_BIN: ZOO, PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}` });
    await taskClient.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "task-e2e", version: "1" } });
    taskClient.notify("notifications/initialized");
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await taskClient!.request("tools/call", { name, arguments: args });
      const content = (result["result"] as { content: { text: string }[] }).content[0]?.text ?? "{}";
      return JSON.parse(content) as Record<string, unknown>;
    };
    const created = await call("workflow_create", {
      title: "Use updated provider", description: "Append one line to README using the configured Codex provider.",
      goals: ["README is changed"],
      conditions: [{ id: "readme-changed", statement: "README is changed", checker: { kind: "diff", require: ["README.md"] } }],
    });
    const workflowId = String(created["workflow_id"]);
    assert.match(workflowId, /^wf-/);
    const started = await call("workflow_start", { workflow_id: workflowId });
    assert.ok(["PLANNING", "RUNNING"].includes(String(started["state"])), JSON.stringify(started));

    let status: Record<string, unknown> = {};
    const deadline = Date.now() + 30_000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 150));
      status = await call("workflow_status", { workflow_id: workflowId });
    } while (Date.now() < deadline && status["state"] !== "DONE" && status["state"] !== "FAILED");
    assert.equal(status["state"], "DONE", JSON.stringify(status));
    assert.match(readFileSync(join(workspace, "README.md"), "utf8"), /after from injected provider/);

    assert.equal(requests.length, 2, "one planner call and one fake Codex call reached the local endpoint");
    assert.ok(requests.every((r) => r.path === "/changed/v1/chat/completions"), "neither process used the old endpoint or an external host");
    assert.ok(requests.every((r) => r.authorization === `Bearer ${HOT_KEY}`));
    assert.ok(requests.some((r) => JSON.stringify(r.messages).includes("planner of a supervised")), "the local endpoint served the supervisor plan");
    assert.ok(requests.some((r) => JSON.stringify(r.messages).includes("fake codex agent request")), "the injected Codex CLI called the updated provider");

    assert.ok(readFileSync(configPath, "utf8").includes(HOT_KEY) === false, "the key value is absent from persisted config");
    // Open the real run journal through the same reader used by production diagnostics.
    const { Journal } = await import("../../src/journal/journal.ts");
    const j = Journal.open(stateDir, workflowId);
    try {
      const row = j.listAgentRuns().find((run) => run.profileId === "codex-hot");
      assert.ok(row, "the fake Codex invocation is recorded in the production journal");
      assert.deepEqual(row.injection, { provider: "hot", model: MODEL, endpoint: baseUrl, keyVariable: "HOT_KEY", protocol: "openai-compatible" });
      assert.equal(JSON.stringify(row).includes(HOT_KEY), false, "the key value is absent from K4 ledger evidence");
    } finally {
      j.close();
    }
  } finally {
    await configClient?.close();
    await taskClient?.close();
    if (api?.pid) api.kill("SIGTERM");
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
