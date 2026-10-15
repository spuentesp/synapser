import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { metadataEndpointProblems, validateProviderConfig } from "../../src/model/config.ts";
import { providerValidationCases } from "./provider-validation-corpus.ts";

const golden = JSON.parse(readFileSync(new URL("./provider-validation-golden.json", import.meta.url), "utf8")) as { name: string; id: string; value: unknown; output: string[] }[];

describe("provider validation golden (P16.6)", () => {
  test("matches the provider validator captured before the zod migration", () => {
    assert.equal(golden.length, providerValidationCases.length, "corpus changed; update the golden deliberately from the pre-migration validator");
    for (const c of providerValidationCases) {
      const expected = golden.find((row) => row.name === c.name);
      assert.ok(expected, `missing golden: ${c.name}`);
      assert.deepEqual([...validateProviderConfig(c.id, c.value), ...metadataEndpointProblems(c.id, c.value)], expected.output, c.name);
    }
  });
});
