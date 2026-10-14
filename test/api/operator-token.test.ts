import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 17 P17.8 step 1: a write needs the operator token. A missing token or another client's token is refused (401),
// the same origin rule still applies, and the operator token is the one the server was started with.
const OPERATOR = "operator-token-0123456789abcdef0123";
const OTHER = "initiator-token-not-the-operator-0000";

describe("plan 17 P17.8: writes need the operator token", () => {
  let state: string;
  let ws: string;
  let sj: Journal;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "op-token-state-"));
    ws = mkdtempSync(join(tmpdir(), "op-token-ws-"));
    sj = Journal.open(state, "_server");
    const lib = new LibraryStore(state, sj);
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, token: OPERATOR, control: { manager: mgr, library: lib, config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  const put = (headers: Record<string, string>) =>
    fetch(`${base}/api/library/skills/style`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "style", description: "d", content: "# Style\n\nUse short sentences.\n" }) });

  test("a write without a token is refused with BAD_TOKEN", async () => {
    const r = await put({ origin: base });
    assert.equal(r.status, 401);
    assert.equal((await r.json() as { error: string }).error, "BAD_TOKEN");
  });

  test("a write with another client's token is refused", async () => {
    assert.equal((await put({ origin: base, "x-synapser-token": OTHER })).status, 401);
  });

  test("a write with the operator token passes the gate", async () => {
    assert.equal((await put({ origin: base, "x-synapser-token": OPERATOR })).status, 200);
  });
});
