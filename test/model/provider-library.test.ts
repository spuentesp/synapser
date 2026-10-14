import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { journalRecorder, priceResolverForProviders } from "../../src/model/recorder.ts";
import type { ModelCallRecord } from "../../src/model/types.ts";

const provider = (baseUrl: string, model: string, input?: number, output?: number): ProviderConfig => ({
  protocol: "openai-compatible",
  baseUrl,
  apiKeyEnv: ["TEST_PROVIDER_KEY"],
  models: [{ id: model, ...(input === undefined ? {} : { usdPer1MIn: input }), ...(output === undefined ? {} : { usdPer1MOut: output }) }],
});

const record = (baseUrl: string, model: string): ModelCallRecord => ({
  callId: `call-${Math.random()}`,
  runId: "r1",
  taskId: "t1",
  role: "worker",
  requestedModel: model,
  servedModel: model,
  baseUrl,
  startedAt: 1,
  latencyMs: 2,
  httpStatus: 200,
  retries: 0,
  usage: { promptTokens: 1_000_000, completionTokens: 2_000_000, reasoningTokens: null },
  finishReason: "stop",
  fallbackUsed: false,
  error: null,
  request: {},
  response: {},
});

describe("provider-library pricing", () => {
  test("a complete declared tariff becomes known cost for that provider and model", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "provider-price-")), "r1");
    try {
      const providers = { local: provider("https://models.example/v1/", "custom-model", 0.25, 0.75) };
      journalRecorder(journal, priceResolverForProviders(providers))(record("https://models.example/v1", "custom-model"));
      assert.equal(journal.listModelCalls()[0]?.costUsd, 1.75);
    } finally {
      journal.close();
    }
  });

  test("missing and ambiguous declarations stay unknown; they never borrow a global tariff", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "provider-price-")), "r1");
    try {
      const providers = {
        unpriced: provider("https://unpriced.example/v1", "nvidia/nemotron-3-super-120b-a12b"),
        first: provider("https://shared.example/v1", "same-model", 1, 2),
        second: provider("https://shared.example/v1/", "same-model", 9, 10),
      };
      const save = journalRecorder(journal, priceResolverForProviders(providers));
      save(record("https://unpriced.example/v1", "nvidia/nemotron-3-super-120b-a12b"));
      save(record("https://shared.example/v1", "same-model"));
      assert.deepEqual(journal.listModelCalls().map((row) => row.costUsd), [null, null]);
    } finally {
      journal.close();
    }
  });

  test("an undeclared response alias uses the requested model tariff", () => {
    const journal = Journal.open(mkdtempSync(join(tmpdir(), "provider-price-")), "r1");
    try {
      const providers = { local: provider("https://models.example/v1", "catalog-model", 0.25, 0.75) };
      const aliased = record("https://models.example/v1", "catalog-model");
      aliased.servedModel = "deployment-2026-10-14";
      journalRecorder(journal, priceResolverForProviders(providers))(aliased);
      assert.equal(journal.listModelCalls()[0]?.costUsd, 1.75);
    } finally {
      journal.close();
    }
  });
});
