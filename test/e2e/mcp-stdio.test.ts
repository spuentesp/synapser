import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeRepo } from "../fixtures/repo.ts";
import { StdioClient } from "./stdio-client.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";

// Plan 18 E7 (H7.1): a client that knows only the protocol starts `synapser mcp` as a process and talks to it over stdio.
// The workspace is a throwaway repository; the state directory is throwaway too.


describe("H7.1 a stdio client drives synapser mcp as a process", () => {
  let repo: string;
  let config: string;
  let client: StdioClient;
  beforeEach(async () => {
    repo = makeRepo(21);
    config = mkdtempSync(join(tmpdir(), "e2e-mcp-cfg-"));
    writeFileSync(join(config, "synapser.config.json"), JSON.stringify({ workspace: repo, stateDir: join(config, "state") }));
    client = new StdioClient(config);
    // The protocol handshake every MCP client performs first.
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } });
    client.notify("notifications/initialized");
  });
  afterEach(async () => {
    await client.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  });

  test("the server answers tools/list with its contract's tools, and no configuration tool", async () => {
    const r = await client.request("tools/list");
    const names = ((r["result"] as { tools: { name: string }[] }).tools).map((t) => t.name);
    assert.equal(names.length, 20);
    assert.ok(names.includes("workflow_list"));
    assert.equal(names.some((n) => n.startsWith("config_")), false);
  });

  test("a real call returns an empty workflow list, and an unknown method is refused by the protocol", async () => {
    const list = await client.request("tools/call", { name: "workflow_list", arguments: {} });
    assert.ok(list["result"], JSON.stringify(list));
    const text = ((list["result"] as { content: { text: string }[] }).content[0]!).text;
    assert.deepEqual(JSON.parse(text), { workflows: [] });
    const bad = await client.request("no/such/method");
    assert.ok(bad["error"], "an unknown method gets an error answer");
  });

  test("a published recipe request over the real stdio process creates only a DRAFT", async () => {
    const state = join(config, "state");
    const journal = Journal.open(state, "_server");
    try {
      const library = new LibraryStore(state, journal);
      const recipe = {
        schemaVersion: 1,
        title: "Review selected files",
        description: "Review selected files and report evidence without changing the workspace.",
        category: "review",
        parameters: [{ name: "scope", type: "string_list", description: "Files to review.", required: true }],
        requiredCapabilities: [],
        requiredSkills: [],
        requiredMcpServers: [],
        workflow: {
          title: "Review {{scope}}",
          description: "Review {{scope}} and report evidence.",
          goals: ["Report evidence for {{scope}}"],
          nonGoals: ["Do not modify files"],
          conditions: [{ id: "report", statement: "The review report exists", checker: { kind: "file", path: "review.md", assert: "exists" } }],
          budget: { minutes: 5 },
        },
        startPolicy: "draft",
      };
      const entry = library.put("recipes", "review-selected", recipe, "operator").entry;
      library.publishRecipe("review-selected", entry.digest, "operator");

      const catalog = await client.request("tools/call", { name: "task_catalog", arguments: {} });
      const catalogBody = JSON.parse((((catalog["result"] as { content: { text: string }[] }).content[0]!).text)) as { recipes: { id: string; digest: string }[] };
      assert.deepEqual(catalogBody.recipes.map((item) => [item.id, item.digest]), [["review-selected", entry.digest]]);

      const response = await client.request("tools/call", { name: "task_request", arguments: { recipe_id: "review-selected", params: { scope: ["README.md"] } } });
      const body = JSON.parse((((response["result"] as { content: { text: string }[] }).content[0]!).text)) as { workflow_id: string; state: string; recipe: { digest: string } };
      assert.equal(body.state, "DRAFT");
      assert.equal(body.recipe.digest, entry.digest);
      const listed = await client.request("tools/call", { name: "workflow_list", arguments: {} });
      const workflows = JSON.parse((((listed["result"] as { content: { text: string }[] }).content[0]!).text)) as { workflows: { workflow_id: string; state: string }[] };
      assert.deepEqual(workflows.workflows, [{ workflow_id: body.workflow_id, title: "Review README.md", state: "DRAFT" }]);
    } finally {
      journal.close();
    }
  });
});
