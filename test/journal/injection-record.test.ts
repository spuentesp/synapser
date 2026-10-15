import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Journal, type AgentRunInsert } from "../../src/journal/journal.ts";

// Plan 17 K4: a run records the provider it was injected with, by name and endpoint, never a key value.
const DIGEST = `sha256:${"b".repeat(64)}`;
const run = (id: string, injection: AgentRunInsert["injection"]): AgentRunInsert => ({
  agentRunId: id, runId: "run-k4", taskId: "t1", profileId: "codex-writer", role: "writer", adapter: "codex", startedAt: 1, finishedAt: 2, durationMs: 1,
  argv: ["codex", "exec"], baseDigest: DIGEST, exitCode: 0, signal: null, timedOut: false, outcome: "SUCCEEDED", reason: null, sessionId: null,
  models: [], usageProvenance: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  costUsd: null, turns: null, apiMs: null, networkIsolated: false, permissionDenials: null, promptBlob: null, stdoutBlob: null, stderrBlob: null,
  finalTextBlob: null, toolUse: null, changes: [], injection,
});

describe("plan 17 K4: the run record names the injected provider", () => {
  test("an injected run reads back its provider, model, endpoint and key variable name, and no key value", () => {
    const state = mkdtempSync(join(tmpdir(), "k4-state-"));
    try {
      const j = Journal.open(state, "run-k4");
      const injection = { provider: "p1", model: "m-large", endpoint: "https://models.example/v1", keyVariable: "P1_KEY", protocol: "openai-compatible" };
      j.tx((t) => t.insertAgentRun(run("ar-inj", injection)));
      j.tx((t) => t.insertAgentRun(run("ar-none", null)));
      const rows = j.listAgentRuns();
      assert.deepEqual(rows.find((r) => r.agentRunId === "ar-inj")!.injection, injection);
      assert.equal(rows.find((r) => r.agentRunId === "ar-none")!.injection, null);
      j.close();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
