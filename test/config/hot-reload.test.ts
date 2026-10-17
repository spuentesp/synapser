import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defaultModelConfig, type ProviderConfig, type RoleConfig } from "../../src/model/config.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import type { Role } from "../../src/model/types.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";
import type { McpServerRegistration } from "../../src/mcp/registry.ts";

// Plan 17 P17.8 step 2: a provider or role change is validated, written to the operator's file, and applied in place
// (hot reload). A holder of the live objects sees the change without a restart; an invalid change changes nothing.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

function setup(withFile: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "hot-reload-"));
  const path = join(dir, "synapser.config.json");
  if (withFile) writeFileSync(path, JSON.stringify({ workspace: dir }));
  const defaults = defaultModelConfig();
  const live: LiveConfig = { configPath: withFile ? path : null, providers: { ...defaults.providers }, roles: { ...defaults.roles } as Record<Role, RoleConfig>, mcpServers: [] };
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

describe("plan 19 P19.5: operator MCP registry writes", () => {
  const server: McpServerRegistration = {
    id: "review-tools",
    enabled: true,
    origin: "file:///opt/synapser/review-tools",
    version: "1.0.0",
    command: "/usr/bin/node",
    args: [],
    expectedServer: { name: "review-tools", version: "1.0.0" },
    profiles: { "codex-writer": ["inspect"] },
  };

  test("writes a validated complete registration and revokes it in place", () => {
    const { dir, path } = setup(true);
    const defaults = defaultModelConfig();
    const live: LiveConfig = { configPath: path, providers: { ...defaults.providers }, roles: { ...defaults.roles } as Record<Role, RoleConfig>, mcpServers: [] };
    const holder = live.mcpServers;
    try {
      writeLiveConfig(live, { kind: "mcpServers", id: server.id, value: server });
      assert.equal(holder?.[0]?.enabled, true);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).mcpServers, [server]);
      writeLiveConfig(live, { kind: "mcpServers", id: server.id, value: { ...server, enabled: false } });
      assert.equal(holder?.[0]?.enabled, false, "the runtime-held registry sees revocation without restart");
      assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers[0].enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused MCP update leaves both file and live registry unchanged", () => {
    const { dir, path } = setup(true);
    const defaults = defaultModelConfig();
    const live: LiveConfig = { configPath: path, providers: { ...defaults.providers }, roles: { ...defaults.roles } as Record<Role, RoleConfig>, mcpServers: [] };
    try {
      assert.throws(() => writeLiveConfig(live, { kind: "mcpServers", id: server.id, value: { ...server, env: { TOKEN: "secret" } } }), ConfigWriteError);
      assert.deepEqual(live.mcpServers, []);
      assert.equal(readFileSync(path, "utf8").includes("mcpServers"), false);
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
    live.profiles = loadConfig({ path: join(dir, "synapser.config.json") }).profiles;
    state = mkdtempSync(join(tmpdir(), "hot-api-state-"));
    ws = mkdtempSync(join(tmpdir(), "hot-api-ws-"));
    sj = Journal.open(state, "_server");
    const lib = new LibraryStore(state, sj);
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, token: OPERATOR, control: { manager: mgr, library: lib, config: () => ({ ok: true }), profiles: () => live.profiles ?? [], mcpServers: () => live.mcpServers ?? [], libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }), configWrite: (change) => writeLiveConfig(live, change) } });
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

  test("MCP registration replacement is operator-authenticated and an untrusted write is refused", async () => {
    const server: McpServerRegistration = {
      id: "review-tools", enabled: true, origin: "file:///opt/synapser/review-tools", version: "1.0.0",
      command: "/usr/bin/node", args: [], expectedServer: { name: "review-tools", version: "1.0.0" },
      profiles: { "codex-writer": ["inspect"] },
    };
    const refused = await put("/api/config/mcpServers/review-tools", server, { origin: base });
    assert.equal(refused.status, 401);
    assert.deepEqual(live.mcpServers, []);
    const accepted = await put("/api/config/mcpServers/review-tools", server, ok());
    assert.equal(accepted.status, 200);
    assert.deepEqual(live.mcpServers, [server]);
    const revoked = await put("/api/config/mcpServers/review-tools", { ...server, enabled: false }, ok());
    assert.equal(revoked.status, 200);
    assert.equal(JSON.parse(readFileSync(join(dir, "synapser.config.json"), "utf8")).mcpServers[0].enabled, false);
  });

  test("the editable MCP registry is private to an authenticated same-origin operator", async () => {
    const unauthenticated = await fetch(`${base}/api/config/mcpServers`, { headers: { origin: base } });
    assert.equal(unauthenticated.status, 401);
    const crossOrigin = await fetch(`${base}/api/config/mcpServers`, { headers: { origin: "https://attacker.invalid", "x-synapser-token": OPERATOR } });
    assert.equal(crossOrigin.status, 403);
    const authenticated = await fetch(`${base}/api/config/mcpServers`, { headers: { origin: base, "x-synapser-token": OPERATOR } });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { servers: [] });
  });

  test("dedicated native curation exposes only eligible profiles and preserves the rest of the registration", async () => {
    const server: McpServerRegistration = {
      id: "review-tools", enabled: true, origin: "file:///opt/synapser/review-tools", version: "1.0.0",
      command: "/usr/bin/node", args: ["--stdio"], artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "bin/server.js" },
      expectedServer: { name: "review-tools", version: "1.0.0" }, profiles: { "nemotron-worker": ["inspect"], "codex-writer": ["inspect"] },
    };
    const register = await put("/api/config/mcpServers/review-tools", server, ok());
    assert.equal(register.status, 200);

    const unauthorized = await fetch(`${base}/api/mcp/review-tools/native-profiles`, { headers: { origin: base } });
    assert.equal(unauthorized.status, 401);
    const candidates = await fetch(`${base}/api/mcp/review-tools/native-profiles`, { headers: ok() });
    assert.equal(candidates.status, 200);
    const candidateBody = await candidates.json() as { profiles: { id: string }[] };
    assert.deepEqual(candidateBody.profiles.map(({ id }) => id), ["nemotron-worker"]);

    const write = await put("/api/mcp/review-tools/native-read-only", { profiles: { "nemotron-worker": ["inspect"] } }, ok());
    assert.equal(write.status, 200);
    const stored = JSON.parse(readFileSync(join(dir, "synapser.config.json"), "utf8")) as { mcpServers: Record<string, unknown>[]; workspace: string };
    assert.deepEqual(stored.mcpServers[0], { ...server, nativeReadOnlyProfiles: { "nemotron-worker": ["inspect"] } });
    assert.equal(stored.workspace, dir);
    assert.deepEqual(live.mcpServers?.[0]?.nativeReadOnlyProfiles, { "nemotron-worker": ["inspect"] });
    assert.deepEqual(loadConfig({ path: join(dir, "synapser.config.json") }).mcpServers[0]?.nativeReadOnlyProfiles, { "nemotron-worker": ["inspect"] }, "the atomically persisted grant survives config reload");

    // The ordinary full-registration form does not own native curation; omitting the property preserves it.
    const normalUpdate = await put("/api/config/mcpServers/review-tools", { ...server, version: "1.0.1" }, ok());
    assert.equal(normalUpdate.status, 200);
    assert.deepEqual(live.mcpServers?.[0]?.nativeReadOnlyProfiles, { "nemotron-worker": ["inspect"] });
    assert.equal(live.mcpServers?.[0]?.version, "1.0.1");
    const wrongWriter = await put("/api/config/mcpServers/review-tools", { ...server, nativeReadOnlyProfiles: {} }, ok());
    assert.equal(wrongWriter.status, 200);
    assert.deepEqual(live.mcpServers?.[0]?.nativeReadOnlyProfiles, { "nemotron-worker": ["inspect"] }, "full-registration writes cannot change native grants");

    const clear = await put("/api/mcp/review-tools/native-read-only", { profiles: {} }, ok());
    assert.equal(clear.status, 200);
    assert.equal(Object.hasOwn(live.mcpServers?.[0] ?? {}, "nativeReadOnlyProfiles"), false);
    assert.equal(Object.hasOwn(loadConfig({ path: join(dir, "synapser.config.json") }).mcpServers[0] ?? {}, "nativeReadOnlyProfiles"), false, "empty curation revokes the grant in the persisted config");
  });

  test("dedicated native curation rejects ineligible profiles and tools outside the general allowlist", async () => {
    const server: McpServerRegistration = {
      id: "review-tools", enabled: true, origin: "file:///opt/synapser/review-tools", version: "1.0.0",
      command: "/usr/bin/node", args: [], artifact: { digest: `sha256:${"b".repeat(64)}`, entrypoint: "bin/server.js" },
      expectedServer: { name: "review-tools", version: "1.0.0" }, profiles: { "nemotron-worker": ["inspect"] },
    };
    assert.equal((await put("/api/config/mcpServers/review-tools", server, ok())).status, 200);
    for (const profiles of [
      { "nemotron-repair": ["inspect"] },
      { "claude-opus-advisor": ["inspect"] },
      { "codex-writer": ["inspect"] },
      { "nemotron-worker": ["mutate"] },
    ]) {
      const response = await put("/api/mcp/review-tools/native-read-only", { profiles }, ok());
      assert.equal(response.status, 400);
      assert.deepEqual(live.mcpServers?.[0]?.nativeReadOnlyProfiles, undefined);
    }
  });

  test("dedicated native curation refuses disabled or unpinned servers", async () => {
    const server: McpServerRegistration = {
      id: "review-tools", enabled: true, origin: "file:///opt/synapser/review-tools", version: "1.0.0",
      command: "/usr/bin/node", args: [], artifact: { digest: `sha256:${"c".repeat(64)}`, entrypoint: "bin/server.js" },
      expectedServer: { name: "review-tools", version: "1.0.0" }, profiles: { "nemotron-worker": ["inspect"] },
    };
    assert.equal((await put("/api/config/mcpServers/review-tools", server, ok())).status, 200);
    assert.equal((await put("/api/config/mcpServers/review-tools", { ...server, enabled: false }, ok())).status, 200);
    assert.equal((await fetch(`${base}/api/mcp/review-tools/native-profiles`, { headers: ok() })).status, 409);
    assert.equal((await put("/api/mcp/review-tools/native-read-only", { profiles: { "nemotron-worker": ["inspect"] } }, ok())).status, 409);
    assert.equal((await put("/api/config/mcpServers/review-tools", { ...server, artifact: undefined }, ok())).status, 200);
    assert.equal((await fetch(`${base}/api/mcp/review-tools/native-profiles`, { headers: ok() })).status, 409);
    assert.equal((await put("/api/mcp/review-tools/native-read-only", { profiles: { "nemotron-worker": ["inspect"] } }, ok())).status, 409);
  });
});

// Plan 17 P17.4: a key value sent where a variable name belongs is refused, and the value appears in no answer,
// in the operator file or in the change log.
describe("plan 17 P17.4: a key value never reaches the API answer, the file or the change log", () => {
  test("a provider whose apiKeyEnv is a key value is refused, and the value is absent everywhere", async () => {
    const secret = "sk-test-P17-4-VALUE-0000000001";
    const { dir, path, live } = setup(true);
    const state = mkdtempSync(join(tmpdir(), "p174-state-"));
    const ws = mkdtempSync(join(tmpdir(), "p174-ws-"));
    const sj = Journal.open(state, "_server");
    const mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    live.stateDir = state;
    const OPERATOR = "operator-token-0123456789abcdef0123";
    const api = createApi({ stateDir: state, ssePollMs: 20, token: OPERATOR, control: { manager: mgr, library: new LibraryStore(state, sj), config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }), configWrite: (change) => writeLiveConfig(live, change) } });
    const base = `http://127.0.0.1:${await api.listen(0)}`;
    try {
      const r = await fetch(`${base}/api/config/providers/leak`, { method: "PUT", headers: { "content-type": "application/json", origin: base, "x-synapser-token": OPERATOR }, body: JSON.stringify({ ...HOT, apiKeyEnv: [secret] }) });
      assert.equal(r.status, 400);
      const answer = await r.text();
      assert.equal(answer.includes(secret), false, "the API answer does not echo the value");
      assert.equal(readFileSync(path, "utf8").includes(secret), false, "the operator file does not hold the value");
      assert.equal(readFileSync(join(state, "config-changes.jsonl"), "utf8").includes(secret), false, "the change log does not hold the value");
    } finally {
      await api.close();
      await mgr.close();
      sj.close();
      for (const d of [dir, state, ws]) rmSync(d, { recursive: true, force: true });
    }
  });
});
