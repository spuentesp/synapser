import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { ProviderConfig } from "../../src/model/config.ts";

// Plan 17 P17.8 step 5: agents change at run time. The loader validates the whole file, so an agent is accepted only
// when the file it would produce loads, and its injected provider and model are declared.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("plan 17 P17.8 step 5: agents through the same validation", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfg-agents-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a valid agent is written, appears in the live list, and leaves no candidate behind", () => {
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    const agent = live.profiles!.find((p) => p.id === "hot-agent");
    assert.equal(agent?.injectProvider, "hot");
    assert.equal(agent?.model, "hot-model");
    assert.ok(JSON.parse(readFileSync(path, "utf8")).agents.some((a: { id: string }) => a.id === "hot-agent"));
    assert.equal(existsSync(`${path}.candidate.${process.pid}`), false);
  });

  test("an agent that names an undeclared provider is refused and the file is unchanged", () => {
    const before = readFileSync(path, "utf8");
    const n = live.profiles!.length;
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad", value: { extends: "codex-writer", injectProvider: "nope", model: "hot-model" } }), (e: unknown) => e instanceof ConfigWriteError && /unknown provider nope/.test(e.errors.join(" ")));
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(live.profiles!.length, n);
    assert.equal(existsSync(`${path}.candidate.${process.pid}`), false);
  });

  test("an agent whose model the provider does not declare is refused", () => {
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad2", value: { extends: "codex-writer", injectProvider: "hot", model: "other" } }), (e: unknown) => e instanceof ConfigWriteError && /not declared by provider hot/.test(e.errors.join(" ")));
  });

  test("an agent the loader rejects (an unknown tier) is refused with the loader's problems", () => {
    assert.throws(() => writeLiveConfig(live, { kind: "agents", id: "bad3", value: { extends: "codex-writer", tier: "genius" } }), (e: unknown) => e instanceof ConfigWriteError && e.errors.length > 0);
  });
});
