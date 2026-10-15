import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";
import type { ProviderConfig } from "../../src/model/config.ts";

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
