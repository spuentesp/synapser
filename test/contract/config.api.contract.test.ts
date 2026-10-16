import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { ConfigWriteOk, ConfigWriteRefused, ProviderBody } from "../../src/contracts/config.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { defaultModelConfig, type RoleConfig } from "../../src/model/config.ts";
import type { Role } from "../../src/model/types.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 18 E2: C-CFG-API-1 against a real API. The answers are checked against the contract schemas, not against strings.
const OPERATOR = "operator-token-0123456789abcdef0123";
const HOT = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("C-CFG-API: config API answers follow their contracts", () => {
  let dir: string;
  let state: string;
  let ws: string;
  let sj: Journal;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  let live: LiveConfig;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cfg-api-contract-"));
    const path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir }));
    const d = defaultModelConfig();
    live = { configPath: path, stateDir: dir, providers: { ...d.providers }, roles: { ...d.roles } as Record<Role, RoleConfig> };
    state = mkdtempSync(join(tmpdir(), "cfg-api-state-"));
    ws = mkdtempSync(join(tmpdir(), "cfg-api-ws-"));
    sj = Journal.open(state, "_server");
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, token: OPERATOR, control: { manager: mgr, library: new LibraryStore(state, sj), config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }), configWrite: (change) => writeLiveConfig(live, change) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    for (const d of [dir, state, ws]) rmSync(d, { recursive: true, force: true });
  });

  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json", origin: base, "x-synapser-token": OPERATOR }, body: JSON.stringify(body) });

  test("C-CFG-API-2: GET /api/config returns the configured view", async () => {
    const r = await fetch(`${base}/api/config`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });

  test("C-CFG-API-1: an accepted provider answers { ok: true }", async () => {
    assert.equal(ProviderBody.safeParse(HOT).success, true, "the request body is a valid contract body");
    const r = await put("/api/config/providers/hot", HOT);
    assert.equal(r.status, 200);
    assert.equal(ConfigWriteOk.safeParse(await r.json()).success, true);
  });

  test("C-CFG-API-1: a refused provider answers INVALID_CONFIG with the problems", async () => {
    const r = await put("/api/config/providers/meta", { ...HOT, baseUrl: "http://169.254.169.254/" });
    assert.equal(r.status, 400);
    assert.equal(ConfigWriteRefused.safeParse(await r.json()).success, true);
  });
});
