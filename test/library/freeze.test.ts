import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore, type LibraryDocument } from "../../src/library/store.ts";
import type { ProviderConfig } from "../../src/model/config.ts";

// Plan 14 Q2.5 (L3): a run's snapshot of the library is immutable and self-contained.

const ACTOR = "test:operator";
const provider = (baseUrl: string): LibraryDocument => ({ protocol: "openai-compatible", baseUrl, apiKeyEnv: ["FREEZE_KEY"], models: [{ id: "m1" }] });

describe("library snapshot per run (L3)", () => {
  let state: string;
  let sj: Journal;
  let lib: LibraryStore;
  let run: Journal;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "freeze-"));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
    run = Journal.open(state, "run-1");
    lib.put("providers", "local", provider("https://first.example/v1/"), ACTOR);
    lib.put("skills", "style", { name: "style", description: "tabs", content: "Use tabs." }, ACTOR);
  });
  afterEach(() => {
    run.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
  });

  test("a run keeps the documents it started with, whatever the library does afterwards", () => {
    const frozen = lib.freeze(run);
    lib.put("providers", "local", provider("https://second.example/v1/"), ACTOR);
    lib.remove("skills", "style", ACTOR);
    assert.deepEqual(frozen.get("providers", "local"), { ...provider("https://first.example/v1/"), id: "local" });
    assert.deepEqual(frozen.get("skills", "style"), { name: "style", description: "tabs", content: "Use tabs.", id: "style" });
    // the library itself did move on
    assert.equal((lib.get("providers", "local")!.document as unknown as ProviderConfig).baseUrl, "https://second.example/v1/");
    assert.equal(lib.get("skills", "style"), null);
    assert.equal(frozen.get("providers", "missing"), null);
  });

  test("the snapshot is self-contained: it still reads after the server's artifacts are gone", () => {
    const frozen = lib.freeze(run);
    rmSync(join(state, "_server", "artifacts"), { recursive: true, force: true });
    assert.deepEqual(frozen.get("providers", "local"), { ...provider("https://first.example/v1/"), id: "local" });
  });

  test("the first snapshot of a run wins, and it is recorded once, in the run's journal", () => {
    const first = lib.freeze(run);
    lib.put("providers", "local", provider("https://second.example/v1/"), ACTOR);
    const again = lib.freeze(run);
    assert.deepEqual(again.entries, first.entries);
    assert.equal((again.get("providers", "local") as unknown as ProviderConfig).baseUrl, "https://first.example/v1/");
    const snapshots = run.listEvents().filter((e) => e.entity === "library_snapshot");
    assert.equal(snapshots.length, 1);
    assert.equal((snapshots[0]!.data as { entries: unknown[] }).entries.length, 2);
  });

  test("a snapshot never comes from the _server journal, which is the library itself", () => {
    assert.throws(() => lib.freeze(sj), /_server journal/);
  });
});
