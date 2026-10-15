import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { type AgentRunInsert, Journal } from "../../src/journal/journal.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { journalRecorder, priceResolverForProviders } from "../../src/model/recorder.ts";
import type { ModelCallRecord } from "../../src/model/types.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q4.1: the home summary counts what is active and what it costs, with the SAME figures the Cost view shows:
// agent runs (their own cost, which CLI agents record there) and the planner's calls. A cost that is not declared is
// counted apart, never summed as zero.

const WF = { title: "Home check", description: "A draft that stays active until it is run", conditions: [{ id: "c1", statement: "schema changed", required: true, checker: { kind: "diff", require: ["app/schema.py"] } }] };
const ACTOR = { id: "ui:operator", role: "operator" as const };
const PROVIDER: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["HOME_TEST_KEY"], models: [{ id: "priced", usdPer1MIn: 1, usdPer1MOut: 2 }, { id: "unpriced" }] };
const DIGEST = `sha256:${"a".repeat(64)}`;

function modelCall(runId: string, role: string, model: string, promptTokens: number, completionTokens: number): ModelCallRecord {
  return {
    callId: `c-${role}-${model}-${Math.random()}`, runId, taskId: null, role: role as ModelCallRecord["role"], requestedModel: model, attemptedModel: model, servedModel: model, baseUrl: PROVIDER.baseUrl,
    startedAt: 1, latencyMs: 2, httpStatus: 200, retries: 0, usage: { promptTokens, completionTokens, reasoningTokens: null },
    finishReason: "stop", fallbackUsed: false, error: null, request: {}, response: {},
  };
}

function agentRun(runId: string, id: string, costUsd: number | null): AgentRunInsert {
  return {
    agentRunId: id, runId, taskId: "t1", profileId: "writer-a", role: "writer", adapter: "claude-code", startedAt: 1, finishedAt: 2, durationMs: 1,
    argv: ["claude"], baseDigest: DIGEST, exitCode: 0, signal: null, timedOut: false, outcome: "SUCCEEDED", reason: null, sessionId: null,
    models: ["m"], usageProvenance: "reported", inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    costUsd, turns: null, apiMs: null, networkIsolated: false, permissionDenials: null, promptBlob: null, stdoutBlob: null, stderrBlob: null,
    finalTextBlob: null, toolUse: null, changes: [],
  };
}

describe("home summary (plan 14 Q4.1)", () => {
  let state: string;
  let ws: string;
  let sj: Journal;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "home-state-"));
    ws = mkdtempSync(join(tmpdir(), "home-ws-"));
    sj = Journal.open(state, "_server");
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr, config: () => ({ profiles: [{ id: "a", enabled: true }, { id: "b", enabled: false }] }) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const home = async () =>
    (await fetch(`${base}/api/home`)).json() as Promise<{ workflows: { total: number; active: { title: string }[] }; cost: { knownUsd: number; unknownRuns: number; agentRuns: number }; agents: { total: number; enabled: number }; runs: number; pendingApprovals: number }>;

  test("a new installation shows nothing active, no cost, and the agents from the configuration", async () => {
    assert.deepEqual(await home(), { workflows: { total: 0, active: [] }, pendingApprovals: 0, runsWaiting: [], agents: { total: 2, enabled: 1 }, cost: { knownUsd: 0, unknownRuns: 0, agentRuns: 0 }, runs: 0 });
  });

  test("a draft is active; agent runs with a recorded cost and without one are counted apart, and the planner's priced call adds to the known cost", async () => {
    assert.equal(mgr.create(WF, ACTOR).ok, true);
    // a run with two agent runs: one with its cost recorded (as CLI agents record it), one without
    const run = Journal.open(state, "run-cost");
    try {
      run.tx((t) => {
        t.insertAgentRun(agentRun("run-cost", "ar-known", 2.5));
        t.insertAgentRun(agentRun("run-cost", "ar-unknown", null));
      });
      // the planner's call is priced: 1M input tokens at $1 per million
      journalRecorder(run, priceResolverForProviders({ local: PROVIDER }))(modelCall("run-cost", "supervisor", "priced", 1_000_000, 0));
    } finally {
      run.close();
    }
    // a chat call is not part of the Cost view, so the summary does not add it either
    journalRecorder(sj, priceResolverForProviders({ local: PROVIDER }))(modelCall("_server", "chat", "priced", 1_000_000, 2_000_000));
    const h = await home();
    assert.equal(h.workflows.total, 1, "only the draft is a workflow; the run-cost journal is a run, not a workflow");
    assert.deepEqual(h.workflows.active.map((w) => w.title), ["Home check"]);
    assert.deepEqual(h.cost, { knownUsd: 3.5, unknownRuns: 1, agentRuns: 2 }, "2.5 recorded + 1 planner call; the unpriced run is counted apart, the chat call is not summed");
  });
});
