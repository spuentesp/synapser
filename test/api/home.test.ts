import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { Journal } from "../../src/journal/journal.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { journalRecorder, priceResolverForProviders } from "../../src/model/recorder.ts";
import type { ModelCallRecord } from "../../src/model/types.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q4.1: the home summary counts what is active and what it costs. A call without a declared price is counted
// apart, never summed as zero.

const WF = { title: "Home check", description: "A draft that stays active until it is run", conditions: [{ id: "c1", statement: "schema changed", required: true, checker: { kind: "diff", require: ["app/schema.py"] } }] };
const ACTOR = { id: "ui:operator", role: "operator" as const };
const PROVIDER: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["HOME_TEST_KEY"], models: [{ id: "priced", usdPer1MIn: 1, usdPer1MOut: 2 }, { id: "unpriced" }] };

function call(model: string): ModelCallRecord {
  return {
    callId: `c-${model}-${Math.random()}`, runId: "_server", taskId: null, role: "chat", requestedModel: model, servedModel: model, baseUrl: PROVIDER.baseUrl,
    startedAt: 1, latencyMs: 2, httpStatus: 200, retries: 0, usage: { promptTokens: 1_000_000, completionTokens: 2_000_000, reasoningTokens: null },
    finishReason: "stop", fallbackUsed: false, error: null, request: {}, response: {},
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
  const home = async () => (await fetch(`${base}/api/home`)).json() as Promise<{ workflows: { total: number; active: { title: string }[] }; cost: { knownUsd: number; unknownCalls: number; calls: number }; agents: { total: number; enabled: number }; runs: number; pendingApprovals: number }>;

  test("a new installation shows nothing active, no cost, and the agents from the configuration", async () => {
    assert.deepEqual(await home(), { workflows: { total: 0, active: [] }, pendingApprovals: 0, runsWaiting: [], agents: { total: 2, enabled: 1 }, cost: { knownUsd: 0, unknownCalls: 0, calls: 0 }, runs: 0 });
  });

  test("a draft is active; a priced call adds to the known cost, and an unpriced one is counted apart", async () => {
    assert.equal(mgr.create(WF, ACTOR).ok, true);
    const write = journalRecorder(sj, priceResolverForProviders({ local: PROVIDER }));
    write(call("priced"));
    write(call("unpriced"));
    const h = await home();
    assert.equal(h.workflows.total, 1);
    assert.deepEqual(h.workflows.active.map((w) => w.title), ["Home check"]);
    assert.deepEqual(h.cost, { knownUsd: 5, unknownCalls: 1, calls: 2 }, "1M in at $1 + 2M out at $2 = $5; the unpriced call is not zero");
  });
});
