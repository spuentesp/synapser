import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q3.1: the designer checks a draft with the SAME validator as create, lists every problem, and writes nothing.

const VALID = {
  title: "Mark the schema",
  description: "Mark the schema file so the designer check has a valid draft",
  goals: ["schema marked"],
  nonGoals: [],
  conditions: [{ id: "schema", statement: "schema changed", required: true, checker: { kind: "diff", require: ["app/schema.py"] } }],
};

describe("workflow designer check (plan 14 Q3.1)", () => {
  let state: string;
  let ws: string;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "designer-state-"));
    ws = mkdtempSync(join(tmpdir(), "designer-ws-"));
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(["imports"]), profileIds: new Set(["w-schema"]), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr, config: () => ({ ok: true }) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const check = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/designer/check`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ok = (): Record<string, string> => ({ origin: base, "x-synapser-token": api.token });

  test("a valid draft passes, and the check writes nothing", async () => {
    const r = await check(VALID, ok());
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(mgr.list(), [], "no workflow was created");
  });

  test("an invalid draft lists every problem at once, with the validator's own wording", async () => {
    const bad = {
      ...VALID,
      title: "ab",
      conditions: [
        { id: "c1", statement: "does a thing", required: true, checker: { kind: "command", commandId: "rm" } },
        { id: "c2", statement: "the review is fine", required: true, checker: { kind: "review", profile: "w-schema", rubric: "is it ok?" } },
      ],
    };
    const body = (await (await check(bad, ok())).json()) as { ok: boolean; errors: string[] };
    assert.equal(body.ok, false);
    const text = body.errors.join("\n");
    assert.match(text, /title must be a 3\.\.160 char string/);
    assert.match(text, /commandId "rm" is not an allowlisted command/);
    assert.match(text, /a "review" is an agent's judgement/);
    assert.ok(body.errors.length >= 3, text);
    assert.deepEqual(mgr.list(), []);
  });

  test("the check needs the token and the same origin, like every write", async () => {
    assert.equal((await check(VALID, { origin: base })).status, 401);
    assert.equal((await check(VALID, { origin: "http://evil.example", "x-synapser-token": api.token })).status, 403);
  });
});
