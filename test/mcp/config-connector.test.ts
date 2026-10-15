import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { ConfigConnector } from "../../src/mcp/config-connector.ts";
import { McpServer } from "../../src/mcp/server.ts";
import { defaultModelConfig, type ProviderConfig, type RoleConfig } from "../../src/model/config.ts";
import type { Role } from "../../src/model/types.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 17 P17.8 step 3: the configuration connector forwards to the API with the operator token. The task connector
// never lists its tools (K3), and a short token is refused at start.
const TOKEN = "operator-token-0123456789abcdef0123";
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("plan 17 P17.8 step 3: the configuration connector", () => {
  let dir: string;
  let state: string;
  let ws: string;
  let sj: Journal;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let live: LiveConfig;
  let connector: ConfigConnector;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cfg-conn-"));
    const path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir }));
    const d = defaultModelConfig();
    live = { configPath: path, providers: { ...d.providers }, roles: { ...d.roles } as Record<Role, RoleConfig> };
    state = mkdtempSync(join(tmpdir(), "cfg-conn-state-"));
    ws = mkdtempSync(join(tmpdir(), "cfg-conn-ws-"));
    sj = Journal.open(state, "_server");
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, token: TOKEN, control: { manager: mgr, library: new LibraryStore(state, sj), config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }), configWrite: (change) => writeLiveConfig(live, change) } });
    const base = `http://127.0.0.1:${await api.listen(0)}`;
    connector = new ConfigConnector({ apiUrl: base, token: TOKEN });
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    for (const d of [dir, state, ws]) rmSync(d, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>) => connector.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  test("a token shorter than 32 characters is refused at start", () => {
    assert.throws(() => new ConfigConnector({ apiUrl: "http://127.0.0.1:1", token: "short" }), /at least 32 characters/);
  });

  test("it lists exactly the two configuration tools", async () => {
    const r = (await connector.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    assert.deepEqual(r.result.tools.map((t) => t.name), ["config_put_provider", "config_put_role"]);
  });

  test("a provider change goes through the API: applied, written, and reported without the token", async () => {
    const r = (await call("config_put_provider", { id: "hot", provider: HOT })) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(r.result.isError, false);
    assert.equal(live.providers["hot"]?.baseUrl, "https://hot.example/v1/");
    assert.equal(r.result.content[0]!.text.includes(TOKEN), false, "the token is never echoed back");
  });

  test("an invalid change comes back as a tool error with its problems", async () => {
    const r = (await call("config_put_provider", { id: "meta", provider: { ...HOT, baseUrl: "http://169.254.169.254/" } })) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0]!.text, /metadata/);
    assert.equal(live.providers["meta"], undefined);
  });

  test("an unknown tool is refused", async () => {
    const r = (await call("config_delete_everything", {})) as { result: { isError: boolean } };
    assert.equal(r.result.isError, true);
  });

  test("the task connector never lists configuration tools (K3)", async () => {
    const task = new McpServer({ manager: mgr, serverJournal: sj });
    const r = (await task.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    const names = r.result.tools.map((t) => t.name);
    assert.equal(names.some((n) => n.startsWith("config_")), false);
    assert.equal(existsSync(join(dir, "synapser.config.json")), true);
  });
});
