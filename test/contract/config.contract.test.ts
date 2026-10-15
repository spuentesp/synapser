import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CONFIG_TOOLS } from "../../src/mcp/config-connector.ts";
import { ConfigToolInputs, ConfigWriteOk, ConfigWriteRefused, ProviderBody, RoleBody } from "../../src/contracts/config.ts";

// Plan 18 E2: the configuration contracts. C-CFG-* in docs/contracts/README.md.
const golden = JSON.parse(readFileSync(new URL("./golden/config-connector.tools.json", import.meta.url), "utf8"));

describe("C-CFG-TOOL: the configuration connector's tools", () => {
  test("C-CFG-TOOL-1: the tool list equals the snapshot; a change needs npm run contracts:update", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(CONFIG_TOOLS)), golden);
  });

  test("C-CFG-TOOL-2: every tool's input schema is the one the contract names", () => {
    assert.deepEqual(Object.keys(ConfigToolInputs).sort(), CONFIG_TOOLS.map((t) => t.name).sort());
  });

  test("C-CFG-TOOL-3: a valid provider and role pass; an unknown field is refused", () => {
    const provider = { protocol: "openai-compatible", baseUrl: "https://models.example/v1", apiKeyEnv: ["MODEL_KEY"], models: [{ id: "m1" }] };
    assert.equal(ProviderBody.safeParse(provider).success, true);
    assert.equal(ProviderBody.safeParse({ ...provider, apiKey: "sk-x" }).success, false, "a key field is not part of the contract");
    assert.equal(RoleBody.safeParse({ provider: "p", model: "m1", temperature: 0.2 }).success, true);
    assert.equal(RoleBody.safeParse({ provider: "p", model: "m1", extra: 1 }).success, false);
  });
});

describe("C-CFG-API: the answers of PUT /api/config/...", () => {
  test("C-CFG-API-1: a success is { ok: true } and a refusal names INVALID_CONFIG with its problems", () => {
    assert.equal(ConfigWriteOk.safeParse({ ok: true }).success, true);
    assert.equal(ConfigWriteRefused.safeParse({ error: "INVALID_CONFIG", errors: ["provider p1: baseUrl must be https"] }).success, true);
    assert.equal(ConfigWriteRefused.safeParse({ error: "INVALID_CONFIG", errors: [] }).success, false, "a refusal always names at least one problem");
  });
});
