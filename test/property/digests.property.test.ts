import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { canonicalJson, digestOfJson } from "../../src/digest/canonical.ts";
import { RUN } from "./support.ts";

// Plan 18 E3 (H3.1): content addressing. Key order never changes a digest; any change of a value does.
describe("H3.1 digests are content addresses", () => {
  test("the digest is the same for equal content, whatever the key order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        assert.equal(canonicalJson(reversed), canonicalJson(obj));
        assert.equal(digestOfJson(reversed), digestOfJson(obj));
      }),
      RUN,
    );
  });

  test("changing one string value changes the digest", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ minLength: 1, maxLength: 20 }), (a, b) => {
        fc.pre(a !== b);
        assert.notEqual(digestOfJson({ k: a }), digestOfJson({ k: b }));
      }),
      RUN,
    );
  });
});
