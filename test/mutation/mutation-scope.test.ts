import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mutationScope } from "../../scripts/mutation-scope.ts";

describe("changed-source mutation module selection", () => {
  test("docs, fixtures and non-source files do not schedule mutation", () => {
    assert.deepEqual(mutationScope([
      "README.md",
      "docs/plans/18-infraestructura-de-pruebas.md",
      "fixtures/billing/app/billing.py",
      "test/library/run-e2e.test.ts",
      "stryker.config.json",
    ]), { modules: [], uncoveredRuntimeFiles: [] });
  });

  test("each configured runtime target selects its stable module", () => {
    assert.deepEqual(mutationScope([
      "src/agents/inject.ts",
      "src/config/write.ts",
      "src/journal/journal.ts",
      "src/executor/executor.ts",
      "src/library/validate.ts",
    ]), {
      modules: ["security", "journal", "executor", "library"],
      uncoveredRuntimeFiles: [],
    });
  });

  test("selection is deterministic, deduplicated and accepts git paths from Windows", () => {
    assert.deepEqual(mutationScope([
      "src\\config\\write.ts",
      "src/config/write.ts",
      "src/library/validate.ts",
    ]), { modules: ["security", "library"], uncoveredRuntimeFiles: [] });
  });

  test("an unmapped runtime file is surfaced instead of silently skipped", () => {
    assert.deepEqual(mutationScope([
      "src/workflow/engine.ts",
      "src/api/server.ts",
      "README.md",
      "src/workflow/engine.ts",
    ]), {
      modules: [],
      uncoveredRuntimeFiles: ["src/api/server.ts", "src/workflow/engine.ts"],
    });
  });
});
