import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { canonicalJson } from "../../src/digest/canonical.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";

// Plan 14 Q2.6: provider prices are decimals ($0.06 per million). Library documents keep them exactly, with a
// stable digest, while the request and journal canonical form keeps refusing non-integers.

const DOC = {
  protocol: "openai-compatible",
  baseUrl: "https://models.example/v1/",
  apiKeyEnv: ["DECIMAL_TEST_KEY"],
  models: [{ id: "cheap", usdPer1MIn: 0.06, usdPer1MOut: 0.24 }, { id: "tiny", usdPer1MIn: 1e-7, usdPer1MOut: 1.25 }],
};

describe("decimal values in library documents (plan 14 Q2.6)", () => {
  let state: string;
  let sj: Journal;
  let lib: LibraryStore;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "decimals-"));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
  });
  afterEach(() => {
    sj.close();
    rmSync(state, { recursive: true, force: true });
  });

  test("decimal prices round-trip exactly, keep one digest across identical writes, and survive a reopen", () => {
    const first = lib.put("providers", "local", DOC, "test:operator");
    assert.equal(first.changed, true);
    const again = lib.put("providers", "local", structuredClone(DOC), "test:operator");
    assert.equal(again.changed, false, "the same document is the same version");
    assert.equal(again.entry.digest, first.entry.digest);
    const models = (lib.get("providers", "local")!.document["models"] as { usdPer1MIn: number }[]);
    assert.equal(models[0]!.usdPer1MIn, 0.06);
    assert.equal(models[1]!.usdPer1MIn, 1e-7);
    sj.close();
    sj = Journal.open(state, "_server");
    const reopened = new LibraryStore(state, sj).get("providers", "local");
    assert.equal(reopened?.digest, first.entry.digest, "the projection rebuilt from the ledger has the same digest");
  });

  test("NaN and infinity are still refused, and the request and journal canonical form still refuses decimals", () => {
    assert.throws(() => lib.put("providers", "local", { ...DOC, models: [{ id: "x", usdPer1MIn: Number.NaN, usdPer1MOut: 1 }] }, "test:operator"), /non-integer number: NaN/);
    assert.throws(() => lib.put("providers", "local", { ...DOC, models: [{ id: "x", usdPer1MIn: Infinity, usdPer1MOut: 1 }] }, "test:operator"), /non-integer number: Infinity/);
    assert.throws(() => canonicalJson({ price: 0.5 }), /non-integer number: 0.5/);
    assert.equal(canonicalJson({ price: 0.5 }, { decimals: true }), '{"price":0.5}');
  });
});
