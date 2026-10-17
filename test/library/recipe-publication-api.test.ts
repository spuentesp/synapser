import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

const TOKEN = "recipe-publication-operator-token";
const RECIPE = {
  schemaVersion: 1,
  title: "Review a change",
  description: "Review a selected change and report findings with evidence.",
  category: "review",
  parameters: [],
  requiredCapabilities: [],
  requiredSkills: [],
  requiredMcpServers: [],
  workflow: {
    title: "Review the change",
    description: "Review the selected change and report evidence.",
    goals: ["Report actionable findings"],
    nonGoals: ["Do not change the workspace"],
    conditions: [{ id: "reviewed", statement: "The review report is present", checker: { kind: "file", path: "review.md", assert: "exists" }, required: true }],
  },
  startPolicy: "draft",
};

describe("recipe publication HTTP lifecycle", () => {
  let state: string;
  let workspace: string;
  let journal: Journal;
  let library: LibraryStore;
  let manager: WorkflowManager;
  let api: ApiServer;
  let base: string;

  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "recipe-publication-state-"));
    workspace = mkdtempSync(join(tmpdir(), "recipe-publication-ws-"));
    journal = Journal.open(state, "_server");
    library = new LibraryStore(state, journal);
    manager = new WorkflowManager({ stateDir: state, workspaceRoot: workspace, commandIds: new Set(), profileIds: new Set(), pollMs: 0, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({
      stateDir: state,
      token: TOKEN,
      ssePollMs: 20,
      control: { manager, library, config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [], bases: [] }) },
    });
    base = `http://127.0.0.1:${await api.listen(0)}`;
    library.put("recipes", "review-change", RECIPE, "ui:operator");
  });

  afterEach(async () => {
    await api.close();
    await manager.close();
    journal.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown, withToken = true) => fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(withToken ? { "x-synapser-token": TOKEN } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  test("publication requires operator token and the exact current digest; unpublish removes catalog visibility", async () => {
    const entry = library.get("recipes", "review-change")!;
    const listingBefore = await call("GET", "/api/library/recipes");
    assert.equal(((await listingBefore.json() as { entries: { id: string; published: boolean }[] }).entries.find((item) => item.id === entry.id))?.published, false);

    const unauthenticated = await call("POST", "/api/library/recipes/review-change/publish", { digest: entry.digest }, false);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json() as { error: string }).error, "BAD_TOKEN");
    assert.deepEqual(library.publishedRecipes(), []);

    const absentDigest = await call("POST", "/api/library/recipes/review-change/publish", {});
    assert.equal(absentDigest.status, 400);
    assert.equal((await absentDigest.json() as { error: string }).error, "PUBLISH_DIGEST_REQUIRED");

    const staleDigest = `sha256:${"0".repeat(64)}`;
    const stale = await call("POST", "/api/library/recipes/review-change/publish", { digest: staleDigest });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: string }).error, "RECIPE_DIGEST_NOT_CURRENT");
    assert.deepEqual(library.publishedRecipes(), []);

    const published = await call("POST", "/api/library/recipes/review-change/publish", { digest: entry.digest });
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), {
      seq: library.history("recipes", "review-change").at(-1)!.seq,
      id: "review-change",
      digest: entry.digest,
      actor: "ui:operator",
      published: true,
    });
    assert.deepEqual(library.publishedRecipes().map((item) => [item.id, item.digest]), [["review-change", entry.digest]]);
    const listingPublished = await call("GET", "/api/library/recipes");
    assert.equal(((await listingPublished.json() as { entries: { id: string; published: boolean }[] }).entries.find((item) => item.id === entry.id))?.published, true);

    const history = await call("GET", "/api/library/recipes/review-change/history", undefined, false);
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as { history: { operation: string; digest: string; actor: string }[] }).history.map(({ operation, digest, actor }) => [operation, digest, actor]), [
      ["PUT", entry.digest, "ui:operator"],
      ["PUBLISH", entry.digest, "ui:operator"],
    ]);

    const unpublished = await call("POST", "/api/library/recipes/review-change/unpublish");
    assert.equal(unpublished.status, 200);
    assert.deepEqual(await unpublished.json(), {
      seq: library.history("recipes", "review-change").at(-1)!.seq,
      id: "review-change",
      digest: entry.digest,
      actor: "ui:operator",
      published: false,
    });
    assert.deepEqual(library.publishedRecipes(), []);
    const listingWithdrawn = await call("GET", "/api/library/recipes");
    assert.equal(((await listingWithdrawn.json() as { entries: { id: string; published: boolean }[] }).entries.find((item) => item.id === entry.id))?.published, false);
  });
});
