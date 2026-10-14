import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore, type LibraryDocument } from "../../src/library/store.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q2.5 (L3) at the engine boundary: an edit made while a run is going never reaches that run.

const ACTOR = { id: "ui:operator", role: "operator" as const };
const WF = { title: "Freeze", description: "Read the library snapshot", conditions: [{ id: "c1", statement: "done", checker: { kind: "diff", require: ["app/schema.py"] } }] };
const provider = (baseUrl: string): LibraryDocument => ({ protocol: "openai-compatible", baseUrl, apiKeyEnv: ["FREEZE_KEY"], models: [{ id: "m1" }] });

describe("a run takes the library as it was when it started (L3)", () => {
  let state: string;
  let ws: string;
  let sj: Journal;
  let lib: LibraryStore;
  let mgr: WorkflowManager | undefined;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "freeze-state-"));
    ws = mkdtempSync(join(tmpdir(), "freeze-ws-"));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
  });
  afterEach(async () => {
    await mgr?.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test("an edit made while the run is going does not change what the engine reads; the start is recorded in the run's journal", async () => {
    lib.put("providers", "local", provider("https://first.example/v1/"), ACTOR.id);
    const seen: { atStart: ProviderConfig | null; afterEdit: ProviderConfig | null } = { atStart: null, afterEdit: null };
    mgr = new WorkflowManager({
      stateDir: state,
      workspaceRoot: ws,
      commandIds: new Set(),
      profileIds: new Set(),
      pollMs: 10,
      library: lib,
      engine: {
        run: async (r) => {
          seen.atStart = r.library!.get("providers", "local") as unknown as ProviderConfig;
          lib.put("providers", "local", provider("https://second.example/v1/"), ACTOR.id);
          seen.afterEdit = r.library!.get("providers", "local") as unknown as ProviderConfig;
          return { status: "DONE", reason: null };
        },
      },
    });
    const created = mgr.create(WF, ACTOR);
    assert.equal(created.ok, true);
    const id = (created as { id: string }).id;
    assert.equal(mgr.start(id, ACTOR).ok, true);
    await mgr.settled(id);
    assert.equal(seen.atStart?.baseUrl, "https://first.example/v1/");
    assert.equal(seen.afterEdit?.baseUrl, "https://first.example/v1/", "the run still sees the library it started with");
    assert.equal((lib.get("providers", "local")!.document as unknown as ProviderConfig).baseUrl, "https://second.example/v1/", "the library itself moved on");
    const run = Journal.open(state, id);
    try {
      assert.equal(run.listEvents().filter((e) => e.entity === "library_snapshot").length, 1);
    } finally {
      run.close();
    }
  });
});
