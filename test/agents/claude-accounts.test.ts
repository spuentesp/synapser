import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { providerForRun } from "../../src/agents/inject.ts";

// Plan 17 P17.6: the operator keeps both Claude accounts. The subscription profile is the built-in one, unchanged;
// the API profile is declared in the operator's file and names an Anthropic-protocol provider.
const dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
const load = (raw: unknown) => {
  const p = join(dir, "c.json");
  writeFileSync(p, JSON.stringify({ workspace: dir, stateDir: join(dir, "s"), ...(raw as object) }));
  return loadConfig({ path: p });
};

// The model id is the operator's choice; the provider must declare it.
const MODEL = "claude-api-model-id";
const operatorFile = {
  providers: {
    "anthropic-main": { protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnv: ["ANTHROPIC_API_KEY"], models: [{ id: MODEL }] },
  },
  agents: [{ id: "claude-sonnet-api", extends: "claude-sonnet-writer", injectProvider: "anthropic-main", model: MODEL }],
};

describe("plan 17 P17.6: two Claude accounts, one profile each", () => {
  test("the subscription profile is the built-in one, unchanged, and keeps its login overlay", () => {
    const cfg = load(operatorFile);
    const sub = cfg.profiles.find((p) => p.id === "claude-sonnet-writer")!;
    assert.equal(sub.injectProvider, undefined);
    assert.deepEqual(sub.homeOverlay, [".claude", ".claude.json"]);
  });

  test("the API profile extends the same agent and names the Anthropic provider", () => {
    const cfg = load(operatorFile);
    const api = cfg.profiles.find((p) => p.id === "claude-sonnet-api")!;
    assert.equal(api.adapter, "claude-code");
    assert.equal(api.injectProvider, "anthropic-main");
    assert.equal(api.model, MODEL);
    assert.equal(cfg.providers["anthropic-main"]!.protocol, "anthropic");
  });

  test("the API profile resolves its key from the operator's environment, and the key is a variable name in the file", () => {
    const cfg = load(operatorFile);
    const resolved = providerForRun("claude-sonnet-api", "anthropic-main", MODEL, cfg.providers, { ANTHROPIC_API_KEY: "sk-test-not-real" });
    assert.equal(resolved.apiKeyEnv, "ANTHROPIC_API_KEY");
    assert.equal(resolved.protocol, "anthropic");
    assert.ok(!JSON.stringify(cfg.providers).includes("sk-test-not-real"), "the configuration never holds the key value");
  });

  test("the API profile is refused without its key, and never falls back to the login", () => {
    const cfg = load(operatorFile);
    assert.throws(() => providerForRun("claude-sonnet-api", "anthropic-main", MODEL, cfg.providers, {}), /ANTHROPIC_API_KEY is not set|none of ANTHROPIC_API_KEY/);
  });
});
