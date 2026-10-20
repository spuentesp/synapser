import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runTask, type TaskSpec } from "../../src/agents/native/loop.ts";
import { EffectBroker } from "../../src/effects/broker.ts";
import { BUILTIN_KINDS } from "../../src/effects/kinds.ts";
import { mcpCallKind } from "../../src/effects/mcp-call.ts";
import type { EffectPort } from "../../src/effects/port.ts";
import type { Policy } from "../../src/effects/policy.ts";
import type { McpServerRegistration } from "../../src/mcp/registry.ts";
import { decideApproval } from "../../src/orchestration/gates.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { effectFixture } from "./mcp-effect-fixture.ts";

// Plan 19 RCP6h, agent path: a native worker asks for an operator effect tool with `request_effect`, the broker holds it
// until a human approves outside the model, and the worker reads the outcome with `effect_status`. The model never
// approves and never sees the result before the decision.
const TASK: TaskSpec = {
  taskId: "notify-1",
  objective: "Send the approved notice to ana@example.com.",
  scope: [],
  criteria: ["the notice is sent once, after a human approves it"],
  planRevision: 1,
};
const POLICY: Policy = { version: 1, default: "deny", rules: [{ id: "ask-mail", kind: "mcp.call", params: { server: "mail" }, decision: "ask" }] };

const toolPayloads = (messages: { role: string; content: string | null }[]) =>
  messages.filter((m) => m.role === "tool").map((m) => JSON.parse(String(m.content).replace(/^[^{]*/, "")) as Record<string, unknown>);

describe("plan 19 RCP6h: a native worker reaches an operator effect tool only through the broker", () => {
  let env: Env;
  let dir: string;
  let servers: McpServerRegistration[];
  let artifactStoreRoot: string;
  let broker: EffectBroker;

  beforeEach(async () => {
    env = await makeEnv();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-agent-effect-")));
    const fixture = effectFixture(dir);
    servers = fixture.servers;
    artifactStoreRoot = fixture.artifactStoreRoot;
    broker = new EffectBroker({
      journal: env.journal,
      runId: RUN,
      repoRoot: env.ws,
      policy: () => POLICY,
      env: {},
      kinds: [...BUILTIN_KINDS, mcpCallKind({ registrations: () => servers, artifactStoreRoot })],
    });
  });
  afterEach(async () => {
    await env.close();
    // the artifact store is read-only by design: make it writable again before removing it
    const makeWritable = (path: string): void => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) makeWritable(join(path, name));
    };
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("request, human approval, then the outcome is read back: the server runs once, after the decision", async () => {
    const port: EffectPort = { request: (r) => broker.request(r), status: (id) => broker.status(id) };
    const model = new ScriptedModel(async (messages, n) => {
      if (n === 1) return { calls: [call("request_effect", { kind: "mcp.call", params: { server: "mail", tool: "send_mail", arguments: { to: "ana@example.com" } }, why: "the task asks for the approved notice" })] };
      if (n === 2) {
        // the human decides outside the model: approve what the broker is holding, then let it run
        const requested = toolPayloads(messages).find((p) => typeof p["id"] === "string" && p["state"] === "PENDING")!;
        const id = String(requested["id"]);
        const rec = broker.status(id)!;
        assert.equal(decideApproval(env.journal, RUN, { taskId: `effect:${id}`, planDigest: rec.digest, currentDigest: rec.digest, decision: "APPROVED", actor: "ana", channel: "cli" } as never).ok, true);
        await broker.tick();
        return { calls: [call("effect_status", { id })] };
      }
      return { calls: [call("finish", { summary: "notice sent" })] };
    });

    const r = await runTask({ model, executor: env.exec, journal: env.journal, runId: RUN, effects: port }, TASK);

    assert.equal(r.status, "FINISHED");
    const before = toolPayloads(model.seen[1]!);
    assert.equal(before.at(-1)?.["state"], "PENDING", "the worker is told the effect is pending, not that it ran");
    const after = toolPayloads(model.seen[2]!);
    assert.equal(after.at(-1)?.["state"], "DONE", "the outcome is read back only after the decision");
    const evidence = after.at(-1)?.["evidence"] as Record<string, unknown>;
    assert.match(String(evidence["output"]), /sent to ana@example\.com/);
    assert.equal(evidence["trust"], "UNTRUSTED_MCP_DATA", "the output reaches the worker as data");
    assert.equal(broker.records().length, 1, "exactly one effect was requested");
  });
});
