import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { validateWorkflow } from "../../src/workflow/model.ts";
import { workflowValidationCases } from "./validation-corpus.ts";

const golden = JSON.parse(readFileSync(new URL("./validation-golden.json", import.meta.url), "utf8")) as { name: string; value: unknown; output: unknown }[];

describe("workflow validation golden (P16.6)", () => {
  test("matches the workflow validator captured before the zod migration", () => {
    assert.equal(golden.length, workflowValidationCases.length, "corpus changed; update the golden deliberately from the pre-migration validator");
    for (const c of workflowValidationCases) {
      const expected = golden.find((row) => row.name === c.name);
      assert.ok(expected, `missing golden: ${c.name}`);
      assert.deepEqual(validateWorkflow(c.value, {
        workspaceRoot: resolve("fixtures/billing/baseline"), commandIds: new Set(["unit"]), profileIds: new Set(["adv"]),
      }), expected.output, c.name);
    }
  });
});
