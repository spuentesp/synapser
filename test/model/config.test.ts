import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  declaredModelPrice,
  defaultModelConfig,
  modelConfigForProvider,
  type ProviderConfig,
  validateConfig,
  validateProviderConfig,
} from "../../src/model/config.ts";

const provider = (models: ProviderConfig["models"]): ProviderConfig => ({
  protocol: "openai-compatible",
  baseUrl: "https://models.example/v1/",
  apiKeyEnv: ["MODEL_API_KEY"],
  models,
});

describe("provider configuration", () => {
  test("declared models carry their price into the recorder shape; undeclared prices stay unknown", () => {
    const p = provider([
      { id: "priced", usdPer1MIn: 0.25, usdPer1MOut: 0.75 },
      { id: "unknown" },
    ]);
    assert.deepEqual(declaredModelPrice(p, "priced"), { inputPerMillionUsd: 0.25, outputPerMillionUsd: 0.75 });
    assert.equal(declaredModelPrice(p, "unknown"), null);
    assert.equal(declaredModelPrice(p, "missing"), null);
  });

  test("provider validation rejects the complete invalid document, including ambiguous prices", () => {
    const errors = validateProviderConfig("Bad ID", {
      protocol: "other",
      baseUrl: "http://remote.example/v1/",
      apiKeyEnv: ["literal-secret!"],
      models: [{ id: "same", usdPer1MIn: 1 }, { id: "same", usdPer1MIn: Number.NaN, usdPer1MOut: -1 }],
    });
    assert.match(errors.join("\n"), /lowercase slug/);
    assert.match(errors.join("\n"), /unsupported protocol/);
    assert.match(errors.join("\n"), /must be https/);
    assert.match(errors.join("\n"), /environment variable names/);
    assert.match(errors.join("\n"), /declare both input and output prices/);
    assert.match(errors.join("\n"), /duplicated/);
    assert.match(errors.join("\n"), /non-negative finite number/);
  });

  test("roles and native-agent configs may only select models declared by their provider", () => {
    const p = provider([{ id: "served" }]);
    assert.throws(() => modelConfigForProvider("custom", p, "missing"), /not declared/);

    const cfg = defaultModelConfig();
    cfg.roles.worker = { provider: "tokenfactory", model: "missing", temperature: 0 };
    assert.throws(() => validateConfig(cfg), /not declared/);
  });
});
