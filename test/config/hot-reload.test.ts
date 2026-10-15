import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { defaultModelConfig, type ProviderConfig, type RoleConfig } from "../../src/model/config.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import type { Role } from "../../src/model/types.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 17 P17.8 step 2: a provider or role change is validated, written to the operator's file, and applied in place
// (hot reload). A holder of the live objects sees the change without a restart; an invalid change changes nothing.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

function setup(withFile: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "hot-reload-"));
  const path = join(dir, "synapser.config.json");
  if (withFile) writeFileSync(path, JSON.stringify({ workspace: dir }));
  const defaults = defaultModelConfig();
  const live: LiveConfig = { configPath: withFile ? path : null, providers: { ...defaults.providers }, roles: { ...defaults.roles } as Record<Role, RoleConfig> };
  return { dir, path, live };
}

describe("plan 17 P17.8: hot reload of providers and roles", () => {
  test("a valid provider is written to the file and seen by a holder of the live table, without a restart", () => {
    const { dir, path, live } = setup(true);
    const holder = live.providers; // what the runtime keeps
    try {
      writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
      assert.equal(holder["hot"]?.baseUrl, "https://hot.example/v1/");
      assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.hot.apiKeyEnv[0], "HOT_KEY");
      assert.ok(!readFileSync(path, "utf8").includes("sk-"), "the file holds names, never key values");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a role can then use the new provider; the change is applied to the holder of the roles too", () => {
    const { dir, live } = setup(true);
    try {
      writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
      const roles = live.roles;
      writeLiveConfig(live, { kind: "roles", id: "supervisor", value: { provider: "hot", model: "hot-model", temperature: 0 } });
      assert.equal(roles.supervisor.provider, "hot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalid change is refused with its problems and nothing is written or applied", () => {
    const { dir, path, live } = setup(true);
    try {
      const before = JSON.stringify(live.providers);
      assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "meta", value: { ...HOT, baseUrl: "http://169.254.169.254/latest" } }), (e: unknown) => e instanceof ConfigWriteError && /metadata/.test((e as ConfigWriteError).errors.join(" ")));
      assert.equal(JSON.stringify(live.providers), before);
      assert.equal(existsSync(path) && readFileSync(path, "utf8").includes("169.254"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a role naming a model its provider does not declare is refused", () => {
    const { dir, live } = setup(true);
    try {
      writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
      assert.throws(() => writeLiveConfig(live, { kind: "roles", id: "worker", value: { provider: "hot", model: "not-declared", temperature: 0 } }), ConfigWriteError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without an operator file there is nothing to write, and the change is refused", () => {
    const { dir, live } = setup(false);
    try {
      assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT }), /no operator file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan 17 P17.8: the API route for provider and role changes", () => {
  const OPERATOR = "operator-token-0123456789abcdef0123";
  let state: string;
  let ws: string;
  let sj: Journal;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  let dir: string;
  let live: LiveConfig;
  beforeEach(async () => {
    ({ dir, live } = setup(true));
    state = mkdtempSync(join(tmpdir(), "hot-api-state-"));
    ws = mkdtempSync(join(tmpdir(), "hot-api-ws-"));
    sj = Journal.open(state, "_server");
    const lib = new LibraryStore(state, sj);
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, token: OPERATOR, control: { manager: mgr, library: lib, config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }), configWrite: (change) => writeLiveConfig(live, change) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ok = (): Record<string, string> => ({ origin: base, "x-synapser-token": OPERATOR });

  test("a provider written with the operator token is applied and returns 200", async () => {
    const r = await put("/api/config/providers/hot", HOT, ok());
    assert.equal(r.status, 200);
    assert.equal(live.providers["hot"]?.baseUrl, "https://hot.example/v1/");
  });

  test("the same write without the operator token is refused and changes nothing", async () => {
    const r = await put("/api/config/providers/hot", HOT, { origin: base });
    assert.equal(r.status, 401);
    assert.equal(live.providers["hot"], undefined);
  });

  test("an invalid change answers 400 with every problem named", async () => {
    const r = await put("/api/config/providers/hot", { ...HOT, baseUrl: "http://169.254.169.254/" }, ok());
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string; errors: string[] };
    assert.equal(body.error, "INVALID_CONFIG");
    assert.match(body.errors.join(" "), /metadata/);
  });
});
