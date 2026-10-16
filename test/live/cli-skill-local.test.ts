// Q1.9 local-only proof: run installed CLIs and the Synapser runner against a scripted loopback provider.
// Never run this test outside the bwrap network namespace command documented below.
// The child CLI receives only a dummy key; no user HOME or provider credential is inherited.
//
// Example (select only CLIs whose local protocol fixture is supported):
// env -i PATH=/opt/q19/node/bin:/opt/q19/kimi:/opt/q19/mimo:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
//   SYNAPSER_LOCAL_SKILL_CLIS=codex-writer,kimi-writer,mimo-writer SYNAPSER_LOCAL_SKILL_NETNS=1 \
//   bwrap --unshare-net --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /home/spuentesp --tmpfs /opt \
//   --dir /opt/q19 --ro-bind /home/spuentesp/.config/nvm/versions/node/v24.21.0 /opt/q19/node \
//   --ro-bind /home/spuentesp/.kimi-code/bin /opt/q19/kimi --ro-bind /home/spuentesp/.mimocode/bin /opt/q19/mimo \
//   --ro-bind /dev/null /data/agents/orca/synapser/.env --tmpfs /data/agents/orca/synapser/.git \
//   --chdir /data/agents/orca/synapser /opt/q19/node/bin/node --test test/live/cli-skill-local.test.ts
//
// Invariant: the provider endpoint is loopback-only and the unique descriptor marker comes only from
// the injected skill, never from the task prompt. The server must observe that marker in a real CLI
// request body; `agent_runs.skills` alone is not proof of delivery.
// Verifier: request capture plus the runner's recorded id/digest/mechanism and a successful CLI parse.
// Falsification: disable skill injection or alter its discovery path; the local server must not see
// the descriptor marker and this test must fail. A response is scripted only after recording input;
// it does not fabricate a workspace change or pretend to prove model-quality/use.

import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import type { AgentAdapter, InjectedSkill } from "../../src/agents/adapter.ts";
import { ProfileRegistry, type AgentProfile } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import { Journal } from "../../src/journal/journal.ts";

const selected = new Set((process.env["SYNAPSER_LOCAL_SKILL_CLIS"] ?? "").split(",").filter(Boolean));
const DUMMY_KEY = "q19-local-only-dummy-key-not-a-credential";
const MODEL = "synapser-q19-local-model";
const SKILL_ID = "synapser-q19-local-arrival-proof";
const DESCRIPTOR_MARKER = "q19-skill-descriptor-arrived-76c4b0";
const skillContent = `---\nname: ${SKILL_ID}\ndescription: ${DESCRIPTOR_MARKER}. Use when asked to perform the local arrival proof.\n---\n\nWhen invoked, report that the local arrival proof skill was loaded.\n`;
const skill: InjectedSkill = {
  id: SKILL_ID,
  digest: sha256Bytes(Buffer.from(skillContent)),
  content: skillContent,
  source: "library",
};
const prompt = `Use the skill named ${SKILL_ID} and complete the task. The descriptor marker is intentionally not in this prompt.`;
const adapterById: Record<string, AgentAdapter> = {
  "codex-writer": CODEX_ADAPTER,
  "kimi-writer": KIMI_ADAPTER,
  "mimo-writer": MIMO_ADAPTER,
};
const cliById: Record<string, string> = {
  "claude-sonnet-writer": "claude",
  "codex-writer": "codex",
  "kimi-writer": "kimi",
  "mimo-writer": "mimo",
};

interface CapturedRequest {
  path: string;
  method: string;
  body: unknown;
}

function assertBwrapNetworkNamespace(): void {
  assert.equal(process.env["SYNAPSER_LOCAL_SKILL_NETNS"], "1", "run under the documented bwrap --unshare-net command");
  const v4 = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  assert.equal(v4.some((line) => {
    const fields = line.split(/\s+/);
    return fields[1] === "00000000" && fields[0] !== "lo";
  }), false, "IPv4 default route outside loopback must be absent");
  const v6 = readFileSync("/proc/net/ipv6_route", "utf8").trim().split("\n").filter(Boolean);
  assert.equal(v6.some((line) => {
    const fields = line.split(/\s+/);
    return fields[0] === "0".repeat(32) && fields[1] === "00" && fields[9] !== "lo";
  }), false, "IPv6 default route outside loopback must be absent");
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, events: readonly { type: string; [key: string]: unknown }[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function captureBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error("local fixture request too large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function anthropicReply(stream: boolean, res: ServerResponse): void {
  const text = "Local fixture received the skill descriptor.";
  const message = {
    id: "msg_q19_local",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 8 },
  };
  if (!stream) return sendJson(res, message);
  sendSse(res, [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]);
}

function chatReply(stream: boolean, res: ServerResponse): void {
  const text = "Local fixture received the skill descriptor.";
  if (!stream) {
    return sendJson(res, {
      id: "chatcmpl_q19_local",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
    });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ id: "chatcmpl_q19_local", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "chatcmpl_q19_local", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function responsesReply(stream: boolean, res: ServerResponse): void {
  const item = {
    id: "msg_q19_local",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Local fixture received the skill descriptor.", annotations: [] }],
  };
  const response = {
    id: "resp_q19_local",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: MODEL,
    output: [item],
    usage: { input_tokens: 1, output_tokens: 8, total_tokens: 9 },
  };
  if (!stream) return sendJson(res, response);
  sendSse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Local fixture received the skill descriptor." },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Local fixture received the skill descriptor." },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

async function startFixture(adapterId: string): Promise<{ url: string; requests: CapturedRequest[]; close(): Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    let body: unknown;
    try {
      body = await captureBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    requests.push({ path: req.url ?? "", method: req.method ?? "", body });
    if (req.method === "GET") {
      return sendJson(res, { data: [{ id: MODEL, object: "model" }] });
    }
    const stream = typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
    if (adapterId === "kimi") return anthropicReply(stream, res);
    if ((req.url ?? "").includes("/responses")) return responsesReply(stream, res);
    return chatReply(stream, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const suffix = adapterId === "kimi" ? "" : "/v1/";
  return {
    url: `http://127.0.0.1:${address.port}${suffix}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function executableAvailable(program: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH element without disclosing any process environment.
    }
  }
  return false;
}

const profiles = new ProfileRegistry();
for (const profileId of ["codex-writer", "kimi-writer", "mimo-writer"] as const) {
  test(`Q1.9 installed ${profileId} sends the injected skill descriptor to a local provider`, {
    skip: selected.has(profileId) ? false : "opt in with SYNAPSER_LOCAL_SKILL_CLIS inside bwrap --unshare-net",
    timeout: 180_000,
  }, async () => {
    assertBwrapNetworkNamespace();
    const baseProfile = profiles.get(profileId)!;
    const adapter = adapterById[profileId]!;
    assert.ok(executableAvailable(cliById[profileId]!), `${cliById[profileId]} must be installed`);
    // MiMo's catalog entry is disabled after an earlier provider 402. This local-only test enables
    // only its in-memory profile copy; no product configuration or external provider is changed.
    const { disabledReason: _disabledReason, ...enabledProfile } = baseProfile;
    const profile: AgentProfile = { ...enabledProfile, enabled: true };
    const fixture = await startFixture(adapter.id);
    const scratch = mkdtempSync(join(tmpdir(), `synapser-q19-${profileId}-`));
    const workspace = join(scratch, "workspace");
    const state = join(scratch, "state");
    mkdirSync(workspace);
    mkdirSync(state);
    writeFileSync(join(workspace, "README.md"), "local fixture only\n");
    const journal = Journal.open(state, `q19-${profileId}`);
    try {
      const result = await runAgent({
        profile,
        adapter,
        injectedSkills: { skills: [skill] },
        prompt,
        workspaceRoot: workspace,
        runId: `q19-${profileId}`,
        taskId: null,
        journal,
        generation: 1,
        envSource: {
          PATH: process.env["PATH"] ?? "",
          HOME: tmpdir(),
          TMPDIR: tmpdir(),
          LOCAL_Q19_KEY: DUMMY_KEY,
        },
        provider: {
          id: "q19-local",
          baseUrl: fixture.url,
          apiKeyEnv: "LOCAL_Q19_KEY",
          model: MODEL,
          protocol: adapter.id === "kimi" ? "anthropic" : "openai-compatible",
        },
      });

      const localDiagnostic = profileId === "kimi-writer"
        ? `reason=${(result.reason ?? "none").replaceAll(DUMMY_KEY, "[REDACTED]")}; fixture requests=${fixture.requests.map(({ method, path }) => `${method} ${path}`).join(", ") || "none"}`
        : "installed CLI must finish without a process error after the fixture reply";
      assert.equal(result.exitCode, 0, localDiagnostic);
      assert.notEqual(result.outcome, "FAILED", `installed CLI must not report a failed run: ${result.reason ?? "no reason"}`);
      assert.ok(fixture.requests.length > 0, "installed CLI must contact the loopback fixture");
      const expectedPath = adapter.id === "kimi" ? "/v1/messages" : adapter.id === "codex" ? "/v1/responses" : "/v1/chat/completions";
      assert.ok(fixture.requests.every((request) => request.path === expectedPath), "only the adapter's expected API route may reach the fixture");
      const providerBodies = fixture.requests.map((request) => JSON.stringify(request.body));
      assert.ok(providerBodies.some((body) => body.includes(DESCRIPTOR_MARKER)), "unique marker from the skill descriptor must reach the provider request");
      assert.equal(prompt.includes(DESCRIPTOR_MARKER), false, "the task prompt must not carry the marker");
      const expected = [{ id: skill.id, digest: skill.digest, mechanism: adapter.capabilities.skillMechanism }];
      assert.deepEqual(result.skills, expected);
      assert.deepEqual(journal.listAgentRuns()[0]?.skills, expected);
      assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "local fixture only\n", "the local server must not fabricate a workspace edit");
    } finally {
      journal.close();
      await fixture.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

// Claude Code already has the stronger model-backed proof in cli-skill.test.ts; this suite is
// deliberately limited to Codex/Kimi/MiMo's injectable local provider paths.
