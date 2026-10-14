import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import type { Advisor } from "../../src/advisor/advisor.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q4.4: what the advisor proposed and which effects were requested are readable from the UI. Read-only.

const WF = { title: "Notes check", description: "A draft whose advisor and effects are read", conditions: [{ id: "c1", statement: "schema changed", required: true, checker: { kind: "diff", require: ["app/schema.py"] } }] };
const ACTOR = { id: "ui:operator", role: "operator" as const };
const PROPOSAL = { id: "iv-1", type: "rollback", task: "schema", state: "PROPOSED", trigger: "review failed", reason: "the diff is stale" };

describe("advisor interventions and effects over the API (plan 14 Q4.4)", () => {
  let state: string;
  let ws: string;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  let id: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "notes-state-"));
    ws = mkdtempSync(join(tmpdir(), "notes-ws-"));
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20,
      engine: { run: async () => ({ status: "DONE", reason: null }) },
      advisor: () => ({ list: () => [PROPOSAL] }) as unknown as Advisor,
    });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
    const created = mgr.create(WF, ACTOR);
    assert.equal(created.ok, true);
    id = (created as { id: string }).id;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test("the interventions the advisor proposed are listed, with their state and reason", async () => {
    const body = (await (await fetch(`${base}/api/workflows/${id}/interventions`)).json()) as { advisor: boolean; interventions: unknown[] };
    assert.equal(body.advisor, true);
    assert.deepEqual(body.interventions, [PROPOSAL]);
  });

  test("a workflow with no requested effects lists none, and an unknown workflow is refused", async () => {
    assert.deepEqual(await (await fetch(`${base}/api/workflows/${id}/effects`)).json(), { effects: [] });
    assert.equal((await fetch(`${base}/api/workflows/nope/effects`)).status, 404);
    assert.equal((await fetch(`${base}/api/workflows/nope/interventions`)).status, 404);
  });
});
