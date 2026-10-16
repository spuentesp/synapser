// P16.2 local-only adoption proof: the installed MiMo CLI must call a real Synapser MCP tool
// through a scripted OpenAI-compatible endpoint. Run only inside bwrap --unshare-net, with
// HOME/XDG isolated and dummy credentials. No remote model/provider is involved.
//
// Example (adjust the Node installation path if needed):
// env -i PATH=/opt/mimocode/bin:/opt/node/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
//   SYNAPSER_MIMO_LOCAL=1 SYNAPSER_MIMO_BIN=/opt/mimocode/bin/mimo \
//   SYNAPSER_NODE_BIN=/opt/node/bin/node SYNAPSER_REPO=/data/agents/orca/synapser \
//   bwrap --unshare-net --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /home/spuentesp \
//     --tmpfs /opt --dir /opt/mimocode --ro-bind /home/spuentesp/.mimocode /opt/mimocode \
//     --dir /opt/node --ro-bind /home/spuentesp/.config/nvm/versions/node/v24.21.0 /opt/node \
//     --ro-bind /dev/null /data/agents/orca/synapser/.env --tmpfs /data/agents/orca/synapser/.git \
//     --chdir /data/agents/orca/synapser /opt/node/bin/node --test test/live/mimo-mcp-local.test.ts
//
// Invariant: tool definitions offered to the fake model originate from MiMo's real MCP connection;
// the model's tool call is executed by the real Synapser stdio server and its result returns to MiMo.
// Verifier: captured function call + subsequent request containing the MCP tool result.
// Falsification: remove/disable the configured MCP server or break its stdio protocol; no tool call/result.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const DUMMY_KEY = "synapser-p162-local-dummy-key-not-a-credential";
const MODEL = "synapser-p162-local-model";

function assertNetworkNamespace(): void {
  assert.equal(process.env["SYNAPSER_MIMO_LOCAL"], "1", "run inside the documented bwrap --unshare-net command");
  const routes = (awaitRead("/proc/net/route")).trim().split("\n").slice(1);
  assert.equal(routes.some((line) => {
    const fields = line.split(/\s+/);
    return fields[1] === "00000000" && fields[0] !== "lo";
  }), false, "no IPv4 default route beyond loopback");
  const routes6 = awaitRead("/proc/net/ipv6_route").trim().split("\n").filter(Boolean);
  assert.equal(routes6.some((line) => {
    const fields = line.split(/\s+/);
    return fields[0] === "0".repeat(32) && fields[1] === "00" && fields[9] !== "lo";
  }), false, "no IPv6 default route beyond loopback");
}

function awaitRead(path: string): string {
  return readFileSync(path, "utf8");
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function reply(res: ServerResponse, message: Record<string, unknown>, finishReason = "stop", stream = false): void {
  const response = {
    id: "chatcmpl_synapser_p162",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const choice = response.choices[0]!;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({
    id: response.id, object: "chat.completion.chunk", created: 1, model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  chunk({ role: "assistant" });
  if (Array.isArray(message["tool_calls"])) {
    for (const [index, call] of (message["tool_calls"] as Record<string, unknown>[]).entries()) {
      const fn = call["function"] as Record<string, unknown>;
      chunk({ tool_calls: [{ index, id: call["id"], type: call["type"], function: { name: fn["name"], arguments: fn["arguments"] } }] });
    }
  } else if (typeof message["content"] === "string") chunk({ content: message["content"] });
  chunk({}, finishReason);
  res.end("data: [DONE]\n\n");
}

test("P16.2 installed MiMo calls a real Synapser MCP tool using a local model fixture", {
  skip: process.env["SYNAPSER_MIMO_LOCAL"] === "1" ? false : "opt in inside bwrap --unshare-net",
  timeout: 180_000,
}, async () => {
  assertNetworkNamespace();
  const mimoBin = process.env["SYNAPSER_MIMO_BIN"];
  const nodeBin = process.env["SYNAPSER_NODE_BIN"];
  const repo = process.env["SYNAPSER_REPO"];
  assert.ok(mimoBin && nodeBin && repo, "provide the installed MiMo/Node paths and repository root");

  const requests: Record<string, unknown>[] = [];
  const invocation: { name: string | null; id: string | null } = { name: null, id: null };
  const server: Server = createServer(async (req, res) => {
    let body: Record<string, unknown>;
    try { body = await bodyOf(req); } catch { res.writeHead(400).end(); return; }
    requests.push(body);
    const stream = body["stream"] === true;
    const messages = Array.isArray(body["messages"]) ? body["messages"] as Record<string, unknown>[] : [];
    const tools = Array.isArray(body["tools"]) ? body["tools"] as Record<string, unknown>[] : [];
    if (invocation.name === null) {
      const offered = tools.map((item) => {
        const fn = item["function"] as Record<string, unknown> | undefined;
        return typeof fn?.["name"] === "string" ? fn["name"] : null;
      });
      const workflowList = offered.find((name) => name?.endsWith("workflow_list"));
      if (!workflowList) { reply(res, { role: "assistant", content: "Local fixture response." }, "stop", stream); return; }
      invocation.name = workflowList;
      invocation.id = "call_synapser_p162_workflow_list";
      reply(res, { role: "assistant", content: null, tool_calls: [{
        id: invocation.id, type: "function", function: { name: invocation.name, arguments: "{}" },
      }] }, "tool_calls", stream);
      return;
    }
    const returnedToolResult = messages.some((message) => message["role"] === "tool" && message["tool_call_id"] === invocation.id);
    if (!returnedToolResult) { res.writeHead(422).end("expected real MCP result in follow-up request"); return; }
    reply(res, { role: "assistant", content: "The local Synapser MCP tool returned successfully." }, "stop", stream);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const scratch = mkdtempSync(join(tmpdir(), "synapser-p162-mimo-"));
  const home = join(scratch, "home");
  const configDir = join(home, ".config", "mimocode");
  const workspace = join(scratch, "workspace");
  const state = join(scratch, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace);
  const synapserConfig = join(scratch, "synapser.json");
  writeFileSync(synapserConfig, JSON.stringify({ workspace, stateDir: state, research: false, profiles: [] }));
  const localModelConfig = {
    model: "local/synapser-p162-local-model",
    provider: { local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Synapser local fixture",
      options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "{env:SYNAPSER_MIMO_DUMMY_KEY}" },
      models: { "synapser-p162-local-model": { name: MODEL } },
    } },
    mcp: { synapser: {
      type: "local",
      command: [nodeBin, join(repo, "src/cli/main.ts"), "mcp", "--config", synapserConfig],
      enabled: true,
    } },
  };
  writeFileSync(join(configDir, "mimocode.jsonc"), JSON.stringify(localModelConfig));

  try {
    const child = spawn(mimoBin, ["run", "Use the Synapser MCP workflow_list tool once, then report the result.", "--model", "local/synapser-p162-local-model", "--format", "json", "--yolo", "--pure"], {
      cwd: workspace,
      env: {
        PATH: [process.env["PATH"] ?? "", delimiter, "/usr/bin:/bin"].join(""),
        HOME: home,
        TMPDIR: tmpdir(),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        SYNAPSER_MIMO_DUMMY_KEY: DUMMY_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("MiMo local MCP proof timed out")); }, 120_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
    });
    assert.equal(exitCode, 0, `MiMo must complete the local MCP call (stderr: ${stderr.slice(-1500)})`);
    assert.ok(invocation.name?.endsWith("workflow_list"), "the local provider must invoke the real Synapser workflow_list tool");
    assert.ok(requests.length >= 2, "MiMo must make a follow-up model request after the tool call");
    assert.ok(requests.slice(1).some((request) => {
      const messages = Array.isArray(request["messages"]) ? request["messages"] as Record<string, unknown>[] : [];
      return messages.some((message) => message["role"] === "tool" && message["tool_call_id"] === invocation.id);
    }), "the real MCP tool result must be sent back to the local provider");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
