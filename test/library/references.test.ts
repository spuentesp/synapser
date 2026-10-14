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

// Plan 14 Q5.2: an edit or a delete that would break a reference is refused, and names what it would break. A workflow
// that can no longer start stops holding the agents it reviews with.

const OPERATOR = { id: "test:operator", role: "operator" } as const;
const PROVIDER = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["LIB_KEY"], models: [{ id: "m1" }, { id: "m2" }] };
const AGENT = { adapter: "native", description: "reviewer", role: "advisor", tags: [], timeoutMs: 120_000, provider: "lib-provider", model: "m2" };

describe("library references (plan 14 Q5.2)", () => {
  let state: string;
  let ws: string;
  let sj: Journal;
  let lib: LibraryStore;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "refs-state-"));
    ws = mkdtempSync(join(tmpdir(), "refs-ws-"));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: () => new Set(lib.list("agents").map((e) => e.id)), pollMs: 20,
      engine: { run: async () => ({ status: "DONE", reason: null }) },
    });
    api = createApi({
      stateDir: state, ssePollMs: 20,
      control: { manager: mgr, library: lib, config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: ["LIB_KEY"] }) },
    });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", origin: base, "x-synapser-token": api.token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  test("a provider an agent runs on cannot be deleted; the refusal names the agent and nothing is removed", async () => {
    assert.equal((await call("PUT", "/api/library/providers/lib-provider", PROVIDER)).status, 200);
    assert.equal((await call("PUT", "/api/library/agents/lib-agent", AGENT)).status, 200);
    const r = await call("DELETE", "/api/library/providers/lib-provider");
    assert.equal(r.status, 409);
    const body = (await r.json()) as { error: string; references: string[] };
    assert.equal(body.error, "REFERENCED");
    assert.deepEqual(body.references, ["agent lib-agent runs on provider lib-provider"]);
    assert.equal((await call("GET", "/api/library/providers/lib-provider")).status, 200);
  });

  test("an edit that removes a model an agent runs on is refused, with the agent; an edit that keeps every model goes through", async () => {
    await call("PUT", "/api/library/providers/lib-provider", PROVIDER);
    await call("PUT", "/api/library/agents/lib-agent", AGENT);
    const cut = await call("PUT", "/api/library/providers/lib-provider", { ...PROVIDER, models: [{ id: "m1" }] });
    assert.equal(cut.status, 409);
    assert.match(((await cut.json()) as { references: string[] }).references.join("\n"), /agent lib-agent would not resolve with this edit: .*model m2 is not declared by provider lib-provider/);
    const kept = (await (await call("GET", "/api/library/providers/lib-provider")).json()) as { document: { models: { id: string }[] } };
    assert.deepEqual(kept.document.models.map((m) => m.id), ["m1", "m2"], "the refused edit changed nothing");
    assert.equal((await call("PUT", "/api/library/providers/lib-provider", { ...PROVIDER, baseUrl: "https://other.example/v1/" })).status, 200);
  });

  test("an agent a draft workflow reviews with cannot be deleted; once that workflow is cancelled it holds nothing", async () => {
    await call("PUT", "/api/library/providers/lib-provider", PROVIDER);
    await call("PUT", "/api/library/agents/lib-agent", AGENT);
    const created = mgr.create({
      id: "wf-ref", title: "Review", description: "a review with a library agent", goals: ["the change is reviewed"], nonGoals: ["no other change"],
      conditions: [
        { id: "exists", statement: "the file exists", checker: { kind: "file", path: "a.py", assert: "exists" } },
        { id: "rv", statement: "the change is idiomatic", required: false, checker: { kind: "review", profile: "lib-agent", rubric: "judge the style" } },
      ],
    }, OPERATOR);
    assert.equal(created.ok, true, JSON.stringify(created));
    const blocked = await call("DELETE", "/api/library/agents/lib-agent");
    assert.equal(blocked.status, 409);
    assert.deepEqual(((await blocked.json()) as { references: string[] }).references, ["workflow wf-ref reviews with lib-agent"]);
    assert.equal(mgr.cancel("wf-ref", OPERATOR).ok, true);
    assert.equal((await call("DELETE", "/api/library/agents/lib-agent")).status, 200);
  });
});
