import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApi, type ApiServer } from "../../src/api/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

describe("agent trial API (plan 14 Q3.4)", () => {
  let state: string;
  let workspace: string;
  let manager: WorkflowManager;
  let api: ApiServer;
  let base: string;
  let calls: unknown[];

  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "agent-trial-api-state-"));
    workspace = mkdtempSync(join(tmpdir(), "agent-trial-api-workspace-"));
    calls = [];
    manager = new WorkflowManager({ stateDir: state, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(), engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({
      stateDir: state,
      control: {
        manager,
        trialAgent: async (profileId, input) => {
          calls.push({ profileId, input });
          return { trialId: "trial-1", profileId, outcome: "SUCCEEDED", output: "looked around", reason: null, costUsd: null, durationMs: 12, skills: [], changedPaths: [], networkIsolated: false };
        },
      },
    });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });

  afterEach(async () => {
    await api.close();
    await manager.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const request = (headers: Record<string, string> = {}, body: unknown = { task: "Inspect the schema", timeLimitSeconds: 30 }) =>
    fetch(`${base}/api/agents/worker/trial`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("requires the session token and same origin before starting an agent", async () => {
    assert.equal((await request()).status, 401);
    assert.equal((await request({ "x-synapser-token": api.token, origin: "http://attacker.invalid" })).status, 403);
    assert.deepEqual(calls, []);
  });

  test("passes only the requested profile and bounded trial input to the runner", async () => {
    const response = await request({ "x-synapser-token": api.token }, { task: "Inspect the schema", timeLimitSeconds: 30, maxBudgetUsd: 0.1 });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ profileId: "worker", input: { task: "Inspect the schema", timeLimitSeconds: 30, maxBudgetUsd: 0.1 } }]);
    assert.equal((await response.json() as { networkIsolated: boolean }).networkIsolated, false);
  });

  test("malformed trial input is rejected before execution", async () => {
    const response = await request({ "x-synapser-token": api.token }, { task: ["not", "text"], timeLimitSeconds: 30 });
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });
});
