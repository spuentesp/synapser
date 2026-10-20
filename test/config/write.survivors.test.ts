import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import type { McpServerRegistration } from "../../src/mcp/registry.ts";

// Plan 18 E4 (H4.4): the branches of the configuration writer that the mutation run left alive. Each test names the branch it pins.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };
const DUO: ProviderConfig = { ...HOT, models: [{ id: "hot-model" }, { id: "hot-two" }] };

describe("the configuration writer's branches that mutation testing found unpinned", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-surv-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const text = () => readFileSync(path, "utf8");
  const raw = () => JSON.parse(text()) as Record<string, any>;
  const lines = () => readFileSync(join(dir, "state", "config-changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  // A live table built from the given parts, on the same operator file and log.
  const mkLive = (parts: Partial<LiveConfig>): LiveConfig => ({ configPath: path, stateDir: join(dir, "state"), providers: {}, roles: {} as LiveConfig["roles"], ...parts });
  const candidates = () => readdirSync(dir).filter((f) => f.includes(".candidate."));

  test("a provider that fails validation, or names a metadata address, is refused with its own reason and the file does not change", () => {
    const before = text();
    // An unknown protocol is not a ProviderConfig, which is the point: the writer must refuse it.
    const cases: [ProviderConfig, string][] = [[{ ...HOT, protocol: "nonsense" } as unknown as ProviderConfig, "unsupported protocol nonsense"], [{ ...HOT, models: [] }, "models must be a non-empty array"], [{ ...HOT, baseUrl: "http://169.254.169.254/" }, "points at a cloud metadata address"]];
    for (const [bad, reason] of cases) {
      assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "bad", value: bad }), (e: unknown) => e instanceof ConfigWriteError && e.errors.some((m) => m.includes(reason)));
      assert.equal(text(), before, "not one byte changed");
    }
    assert.equal(live.providers["bad"], undefined, "the live table did not take the refused provider");
  });

  test("a role is written under roles, and the providers section keeps its content", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    const providersBefore = JSON.stringify(raw()["providers"]);
    writeLiveConfig(live, { kind: "roles", id: "worker", value: { provider: "hot", model: "hot-model" } });
    assert.deepEqual(raw()["roles"]["worker"], { provider: "hot", model: "hot-model" });
    assert.equal(JSON.stringify(raw()["providers"]), providersBefore);
  });

  test("an agent is accepted when its model is one of several the provider declares, and refused when it is none", () => {
    writeLiveConfig(live, { kind: "providers", id: "duo", value: DUO });
    writeLiveConfig(live, { kind: "agents", id: "duo-agent", value: { extends: "codex-writer", injectProvider: "duo", model: "hot-two" } });
    assert.equal(live.profiles!.find((p) => p.id === "duo-agent")?.model, "hot-two");
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad-agent", value: { extends: "codex-writer", injectProvider: "duo", model: "missing" } }), ConfigWriteError);
  });

  test("an agent change keeps the other agents, and the live providers take the file's content", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    writeLiveConfig(live, { kind: "agents", id: "first-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    writeLiveConfig(live, { kind: "agents", id: "second-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    const ids = raw()["agents"].map((a: { id: string }) => a.id);
    assert.deepEqual(ids.sort(), ["first-agent", "second-agent"]);
    assert.equal(statSync(path).mode & 0o777, 0o600, "the operator file stays private to its owner");

    // A provider the file declares but the live table does not yet hold is picked up by the next agent change.
    const edited = raw();
    edited["providers"]["extra"] = { ...HOT, baseUrl: "https://extra.example/v1/" };
    edited["roles"] = { ...(edited["roles"] ?? {}), worker: { provider: "hot", model: "hot-model" } };
    writeFileSync(path, JSON.stringify(edited));
    writeLiveConfig(live, { kind: "agents", id: "third-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    assert.equal(live.providers["extra"]?.baseUrl, "https://extra.example/v1/");
    assert.equal(live.roles.worker.provider, "hot");
    assert.equal(live.roles.worker.model, "hot-model");
  });

  test("no candidate file is left behind after a refused agent, whichever check refused it", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad", value: { extends: "codex-writer", injectProvider: "nope", model: "x" } }), ConfigWriteError);
    assert.deepEqual(candidates(), []);
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad2", value: { extends: "no-such-profile" } }), ConfigWriteError);
    assert.deepEqual(candidates(), []);
  });

  test("the audit digests move with an applied change, and a refused line starts from the digest the last applied line left", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    const applied = lines().at(-1)!;
    assert.notEqual(applied["digestBefore"], applied["digestAfter"]);
    assert.match(String(applied["digestAfter"]), /^[0-9a-f]{16}$/);
    assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "bad", value: { ...HOT, protocol: "nonsense" } }), ConfigWriteError);
    const refused = lines().at(-1)!;
    assert.equal(refused["digestAfter"], null);
    assert.equal(refused["digestBefore"], applied["digestAfter"]);
  });

  test("an agent change moves the digest, because the agent list is part of what the digest covers", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    const before = lines().at(-1)!["digestAfter"];
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    const after = lines().at(-1)!;
    assert.equal(after["digestBefore"], before);
    assert.notEqual(after["digestAfter"], before);
  });

  test("a table with no agent list digests exactly like one with an empty list", () => {
    const withList = { providers: { ...live.providers }, roles: { ...live.roles }, profiles: [] as typeof live.profiles };
    const withoutList = { providers: { ...live.providers }, roles: { ...live.roles } };
    const sameChange = { kind: "providers" as const, id: "hot", value: HOT };
    const a = mkLive(withList); const b = mkLive(withoutList);
    writeLiveConfig(a, sameChange);
    writeLiveConfig(b, sameChange);
    assert.equal(lines().at(-2)!["digestAfter"], lines().at(-1)!["digestAfter"]);
  });

  test("an agent list with an empty entry is handled as an entry without an id, not as a crash", () => {
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state"), agents: [null] }));
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "x", value: { extends: "codex-writer", injectProvider: "nope", model: "x" } }), (e: unknown) => e instanceof ConfigWriteError);
  });

  test("two tables with the same number of agents but different ids digest differently", () => {
    const a = mkLive({ providers: { ...live.providers }, roles: { ...live.roles }, profiles: [{ id: "alpha" } as AgentProfile] });
    const b = mkLive({ providers: { ...live.providers }, roles: { ...live.roles }, profiles: [{ id: "beta" } as AgentProfile] });
    const change = { kind: "providers" as const, id: "hot", value: HOT };
    writeLiveConfig(a, change);
    const digestA = lines().at(-1)!["digestAfter"];
    writeLiveConfig(b, change);
    const digestB = lines().at(-1)!["digestAfter"];
    assert.notEqual(digestA, digestB);
  });
});

describe("the configuration writer's operator MCP registry branches", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  // A pinned, enabled registration: the shape the loader accepts for a native worker profile.
  const pinned = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    enabled: true,
    origin: "https://example.invalid/mcp/review-tools",
    version: "1.4.2",
    command: "/opt/synapser/mcp/review-tools",
    args: [],
    artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "bin/review-tools" },
    expectedServer: { name: "review-tools", version: "1.4.2" },
    profiles: { "nemotron-worker": ["inspect", "write"] },
    ...patch,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-mcp-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles, mcpServers: [] };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const raw = () => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const lines = () => readFileSync(join(dir, "state", "config-changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const refusedWith = (reason: string) => (e: unknown) => e instanceof ConfigWriteError && e.errors.includes(reason);
  const register = (id: string, value: unknown) => writeLiveConfig(live, { kind: "mcpServers", id, value });
  const curate = (id: string, value: unknown) => writeLiveConfig(live, { kind: "mcpNativeReadOnlyProfiles", id, value });

  test("an MCP server id is a lowercase slug of at most 41 characters, and a bad one is refused by name", () => {
    for (const id of ["-x", "Bad", "abc!", "a".repeat(42)]) {
      assert.throws(() => register(id, pinned(id)), refusedWith("MCP server id is invalid"), id);
    }
    assert.equal(raw()["mcpServers"], undefined, "nothing was written");
  });

  test("a registration must be an object, not null, an array or a string", () => {
    for (const value of [null, [], "server"]) {
      assert.throws(() => register("review-tools", value), refusedWith("an MCP server registration is an object"));
    }
  });

  test("a new registration cannot carry the native grant; only the dedicated curation path adds one", () => {
    const grant = { "nemotron-worker": ["inspect"] };
    assert.throws(() => register("review-tools", pinned("review-tools", { nativeReadOnlyProfiles: grant })), refusedWith("nativeReadOnlyProfiles can only be changed through dedicated native MCP curation"));
    assert.equal(raw()["mcpServers"], undefined, "the refused grant never reached the file");
  });

  test("each registration is written under its own id, so a second one does not overwrite the first", () => {
    register("alpha", pinned("alpha", { profiles: { "nemotron-worker": ["write"] } }));
    register("beta", pinned("beta", { profiles: { "nemotron-worker": ["inspect"] } }));
    assert.deepEqual(raw()["mcpServers"].map((s: { id: string }) => s.id), ["alpha", "beta"]);
  });

  test("an update keeps the native grant already in the file, whatever the payload says", () => {
    register("alpha", pinned("alpha"));
    curate("alpha", { "nemotron-worker": ["inspect"] });
    register("alpha", pinned("alpha", { nativeReadOnlyProfiles: { "nemotron-worker": ["write"] } }));
    assert.deepEqual(raw()["mcpServers"][0]["nativeReadOnlyProfiles"], { "nemotron-worker": ["inspect"] });
  });

  test("an update to a server with no native grant drops any grant the payload carries", () => {
    register("alpha", pinned("alpha"));
    register("alpha", pinned("alpha", { nativeReadOnlyProfiles: { "nemotron-worker": ["inspect"] } }));
    assert.equal("nativeReadOnlyProfiles" in raw()["mcpServers"][0], false);
  });

  test("a curated grant is written to the operator file, and the live registry takes it in place", () => {
    register("alpha", pinned("alpha"));
    const holder = live.mcpServers!;
    curate("alpha", { "nemotron-worker": ["inspect"] });
    assert.deepEqual(raw()["mcpServers"][0]["nativeReadOnlyProfiles"], { "nemotron-worker": ["inspect"] });
    assert.deepEqual(holder[0]?.nativeReadOnlyProfiles, { "nemotron-worker": ["inspect"] });
  });

  test("an empty curation removes the grant key from the file instead of storing an empty map", () => {
    register("alpha", pinned("alpha"));
    curate("alpha", { "nemotron-worker": ["inspect"] });
    curate("alpha", {});
    assert.equal("nativeReadOnlyProfiles" in raw()["mcpServers"][0], false);
  });

  test("curation targets the server it names, and checks a grant against that server's own allowlist", () => {
    register("alpha", pinned("alpha", { profiles: { "nemotron-worker": ["write"] } }));
    register("beta", pinned("beta", { profiles: { "nemotron-worker": ["inspect"] } }));
    curate("beta", { "nemotron-worker": ["inspect"] });
    assert.equal("nativeReadOnlyProfiles" in raw()["mcpServers"][0], false, "alpha is untouched");
    assert.deepEqual(raw()["mcpServers"][1]["nativeReadOnlyProfiles"], { "nemotron-worker": ["inspect"] });
    assert.throws(() => curate("alpha", { "nemotron-worker": ["inspect"] }), refusedWith("profiles.nemotron-worker.inspect is not in the general MCP allowlist"));
  });

  test("curation names each problem: a profile that is not a native worker, a grant that is not a list, and a tool outside the allowlist", () => {
    register("alpha", pinned("alpha", { profiles: { "codex-writer": ["inspect"] } }));
    assert.throws(
      () => curate("alpha", { "codex-writer": ["write"] }),
      (e: unknown) => e instanceof ConfigWriteError && e.errors.includes("profile codex-writer is not eligible for read-only grants") && e.errors.includes("profiles.codex-writer.write is not in the general MCP allowlist"),
    );
    assert.throws(() => curate("alpha", { "codex-writer": "inspect" }), refusedWith("profiles.codex-writer must be a list of tool names"));
    assert.throws(() => curate("alpha", { "codex-writer": [1] }), refusedWith("profiles.codex-writer must be a list of tool names"));
  });

  test("curation accepts only a plain object of profile ids", () => {
    register("alpha", pinned("alpha"));
    const nullPrototype = Object.assign(Object.create(null), { "nemotron-worker": ["inspect"] });
    for (const value of [null, [], "inspect", nullPrototype]) {
      assert.throws(() => curate("alpha", value), refusedWith("native MCP curation must be an object mapping profile ids to tool-name arrays"));
    }
  });

  test("a hand-edited operator file with a null registry entry is refused by the writer, not crashed on", () => {
    register("alpha", pinned("alpha"));
    const file = raw();
    file["mcpServers"].unshift(null);
    writeFileSync(path, JSON.stringify(file));
    assert.throws(() => register("beta", pinned("beta")), ConfigWriteError);
    assert.throws(() => curate("alpha", { "nemotron-worker": ["inspect"] }), ConfigWriteError);
  });

  test("curation refuses an invalid id, an unknown server, and a grant that mixes a non-string into a valid list", () => {
    register("alpha", pinned("alpha"));
    for (const id of ["-x", "Bad", "abc!", "a".repeat(42)]) {
      assert.throws(() => curate(id, { "nemotron-worker": ["inspect"] }), refusedWith("MCP server id is invalid"), id);
    }
    assert.throws(() => curate("nowhere", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "unknown MCP server nowhere");
    assert.throws(() => curate("alpha", { "nemotron-worker": ["inspect", 1] }), refusedWith("profiles.nemotron-worker must be a list of tool names"));
  });

  test("curation refuses a server that is disabled or unpinned in the live registry, by its exact reason", () => {
    register("alpha", pinned("alpha", { enabled: false }));
    assert.throws(() => curate("alpha", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "MCP server alpha is disabled");
    register("beta", pinned("beta", { artifact: undefined }));
    assert.throws(() => curate("beta", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "MCP server beta has no pinned artifact");
  });

  test("curation refuses a server the operator file has disabled or unpinned, even while the live registry still shows it valid", () => {
    register("gamma", pinned("gamma"));
    register("delta", pinned("delta"));
    const file = raw();
    file["mcpServers"][0]["enabled"] = false;
    file["mcpServers"][1]["artifact"] = undefined;
    writeFileSync(path, JSON.stringify(file));
    assert.throws(() => curate("gamma", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "MCP server gamma is disabled in the operator file");
    assert.throws(() => curate("delta", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "MCP server delta has no pinned artifact in the operator file");
  });

  test("curation refuses a server the operator file does not hold, by its exact reason", () => {
    live.mcpServers!.push(pinned("epsilon") as unknown as McpServerRegistration);
    assert.throws(() => curate("epsilon", { "nemotron-worker": ["inspect"] }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length === 1 && e.errors[0] === "MCP server epsilon is missing from the operator file");
  });

  test("curation needs a live registry and live agent profiles, and refuses by name when either is absent", () => {
    register("alpha", pinned("alpha"));
    const reason = "native MCP curation requires a live MCP registry and effective agent profiles";
    const value = { "nemotron-worker": ["inspect"] };
    assert.throws(() => writeLiveConfig({ ...live, mcpServers: undefined }, { kind: "mcpNativeReadOnlyProfiles", id: "alpha", value }), refusedWith(reason));
    assert.throws(() => writeLiveConfig({ ...live, profiles: undefined }, { kind: "mcpNativeReadOnlyProfiles", id: "alpha", value }), refusedWith(reason));
  });

  test("a registration needs a live registry to replace, and without one it is refused by name", () => {
    assert.throws(() => writeLiveConfig({ ...live, mcpServers: undefined }, { kind: "mcpServers", id: "alpha", value: pinned("alpha") }), refusedWith("MCP servers cannot change: this process holds no live registry"));
  });

  test("a provider change leaves the live registry as it is", () => {
    register("alpha", pinned("alpha"));
    const holder = live.mcpServers!;
    holder.push(pinned("ghost") as unknown as McpServerRegistration);
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    assert.deepEqual(holder.map((s) => s.id), ["alpha", "ghost"]);
  });

  test("the audit digest covers the registry, and a table with no registry digests like one with an empty list", () => {
    writeLiveConfig({ ...live, mcpServers: undefined }, { kind: "providers", id: "hot", value: HOT });
    const bare = lines().at(-1)!["digestAfter"];
    writeLiveConfig({ ...live, mcpServers: [] }, { kind: "providers", id: "hot", value: HOT });
    assert.equal(lines().at(-1)!["digestAfter"], bare);
    register("alpha", pinned("alpha"));
    assert.notEqual(lines().at(-1)!["digestAfter"], bare, "a registration moves the digest");
  });
});
