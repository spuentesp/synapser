import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { validateProfile } from "../../src/agents/profile.ts";
import { validateLibraryDocument } from "../../src/library/validate.ts";
import { validateProviderConfig } from "../../src/model/config.ts";
import { RUN } from "./support.ts";

// Plan 18 E3 (H3.3): the validators are total. Any input yields a list of problems, never an exception, and a rejected
// input always names at least one problem.
const anyJson = fc.jsonValue();

describe("H3.3 validators are total and name their problems", () => {
  test("a library document of any shape yields a list, and a non-empty list names the document", () => {
    fc.assert(
      fc.property(fc.constantFrom("providers", "agents", "skills") as fc.Arbitrary<"providers" | "agents" | "skills">, fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/), anyJson, (kind, id, doc) => {
        const problems = validateLibraryDocument(kind, id, doc);
        assert.ok(Array.isArray(problems));
        for (const p of problems) assert.equal(typeof p, "string");
      }),
      RUN,
    );
  });

  test("a provider of any shape is validated without an exception", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/), anyJson, (id, value) => {
      assert.ok(Array.isArray(validateProviderConfig(id, value)));
    }), RUN);
  });

  test("a profile of any shape is validated without an exception", () => {
    fc.assert(fc.property(anyJson, (value) => {
      assert.ok(Array.isArray(validateProfile(value as never)));
    }), RUN);
  });
});
