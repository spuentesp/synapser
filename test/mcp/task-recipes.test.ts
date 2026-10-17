// P19.6: recipe discovery is a curated boundary, not an implicit executable library.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { taskRecipeSchema } from "../../src/library/schema.ts";
import { McpServer } from "../../src/mcp/server.ts";
import type { ProfileCard } from "../../src/orchestration/catalog.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

const recipe = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  title: "Review a change",
  description: "Review a selected change and report findings with evidence.",
  category: "review",
  parameters: [
    { name: "scope", type: "string_list", description: "Paths included in the review.", required: true, maxItems: 5 },
    { name: "focus", type: "string", description: "The review focus.", required: false, default: "security", maxLength: 100 },
  ],
  requiredCapabilities: [],
  requiredSkills: [],
  requiredMcpServers: [],
  workflow: {
    title: "Review {{focus}}",
    description: "Review {{scope}} for {{focus}} and report evidence.",
    goals: ["Review {{scope}}", "Focus on {{focus}}"],
    nonGoals: ["Do not modify the workspace"],
    conditions: [{ id: "reviewed", statement: "The review report is present", checker: { kind: "file", path: "review.md", assert: "exists" }, required: true }],
    budget: { minutes: 5 },
  },
  startPolicy: "draft",
  ...overrides,
});

describe("P19.6 task recipes over MCP", () => {
  let state: string;
  let workspace: string;
  let serverJournal: Journal;
  let library: LibraryStore;
  let manager: WorkflowManager;
  let server: McpServer;
  let cards: ProfileCard[];
  let n: number;

  const rpc = async (method: string, params: Record<string, unknown> = {}) => server.handle({ jsonrpc: "2.0", id: ++n, method, params }) as Promise<any>;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    return { isError: response.result.isError as boolean, body: JSON.parse(response.result.content[0].text) as Record<string, any> };
  };
  const addRecipe = (id: string, doc = recipe()) => library.put("recipes", id, doc, "operator").entry;
  const publish = (id: string) => {
    const current = library.get("recipes", id)!;
    return library.publishRecipe(id, current.digest, "operator");
  };

  beforeEach(() => {
    state = realpathSync(mkdtempSync(join(tmpdir(), "synapser-task-recipes-state-")));
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "synapser-task-recipes-ws-")));
    serverJournal = Journal.open(state, "_server");
    library = new LibraryStore(state, serverJournal);
    manager = new WorkflowManager({
      stateDir: state,
      workspaceRoot: workspace,
      commandIds: new Set(),
      engine: { run: async () => ({ status: "DONE", reason: null }) },
      pollMs: 0,
      library,
    });
    cards = [{ id: "reviewer", kinds: ["review"], integration: "direct", tier: "standard", pool: null, strengths: [], capabilities: { capabilityIds: [], skills: "native-dir" } as any, allowedSkillIds: [], cost: { basis: "unknown", reason: "NO_HISTORY" }, observed: null, enabled: true }];
    server = new McpServer({ manager, serverJournal, library, catalog: () => cards });
    n = 0;
  });

  afterEach(async () => {
    await manager.close();
    serverJournal.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("recipe MCP requirements are exact selections, never server-wide grants", () => {
    assert.equal(taskRecipeSchema.safeParse(recipe({ requiredMcpServers: ["source-reader"] })).success, false,
      "a required server without a named tool is ambiguous and cannot be published");
    assert.equal(taskRecipeSchema.safeParse(recipe({ requiredMcpServers: ["source-reader"], requiredMcpTools: [{ serverId: "other", toolName: "read" }] })).success, false,
      "a selected tool must belong to one of the declared required servers");
    assert.equal(taskRecipeSchema.safeParse(recipe({ requiredMcpServers: ["source-reader"], requiredMcpTools: [{ serverId: "source-reader", toolName: "read" }, { serverId: "source-reader", toolName: "read" }] })).success, false,
      "duplicate tool selections are rejected");
  });

  test("catalog exposes only manually published current recipe digests; edits and deletes withdraw it", async () => {
    addRecipe("draft-only");
    const first = addRecipe("curated");
    assert.deepEqual(library.publishedRecipes(), []);
    await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "caller" }, capabilities: {} });
    assert.deepEqual((await tool("task_catalog")).body.recipes, []);

    const pub = publish("curated");
    assert.equal(pub.digest, first.digest);
    assert.equal(pub.published, true);
    assert.deepEqual(library.publishedRecipes().map((entry) => entry.id), ["curated"]);
    const visible = (await tool("task_catalog")).body.recipes as { id: string; digest: string }[];
    assert.deepEqual(visible.map(({ id, digest }) => [id, digest]), [["curated", first.digest]]);
    assert.equal(visible.some((item) => item.id === "draft-only"), false);

    const historyBefore = library.history("recipes", "curated");
    assert.deepEqual(historyBefore.map((item) => item.operation), ["PUT", "PUBLISH"]);
    assert.equal(historyBefore[1]!.digest, first.digest);
    assert.equal(historyBefore[1]!.actor, "operator");
    assert.ok(historyBefore[1]!.seq > historyBefore[0]!.seq);

    assert.throws(() => library.publishRecipe("curated", "sha256:" + "0".repeat(64) as any, "operator"), /not current/);
    library.put("recipes", "curated", recipe({ title: "Edited recipe" }), "operator");
    assert.deepEqual(library.publishedRecipes(), [], "publication is bound to the old digest and is not inherited by edits");
    assert.deepEqual((await tool("task_catalog")).body.recipes, []);
    const editedHistory = library.history("recipes", "curated");
    assert.deepEqual(editedHistory.map((item) => item.operation), ["PUT", "PUBLISH", "PUT"]);

    publish("curated");
    assert.equal(library.publishedRecipes().length, 1);
    assert.equal(library.remove("recipes", "curated", "operator"), true);
    assert.deepEqual(library.publishedRecipes(), [], "delete withdraws the recipe from discovery");
    assert.deepEqual((await tool("task_catalog")).body.recipes, []);
    assert.deepEqual(library.history("recipes", "curated").map((item) => item.operation), ["PUT", "PUBLISH", "PUT", "PUBLISH", "DELETE"]);
  });

  test("task_request strictly validates parameters, substitutes declared values, and creates DRAFT only", async () => {
    const current = addRecipe("review");
    publish("review");
    await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "not-an-authenticated-identity" }, capabilities: {} });

    for (const params of [
      {},
      { scope: ["src/a.ts"], typo: "ignored?" },
      { scope: "src/a.ts" },
      { scope: ["src/a.ts", 7] },
      { scope: ["a", "b", "c", "d", "e", "f"] },
      { scope: ["src/a.ts"], focus: "x".repeat(101) },
    ]) {
      const rejected = await tool("task_request", { recipe_id: "review", params });
      assert.equal(rejected.isError, true, JSON.stringify(params));
      assert.equal(rejected.body.error, "INVALID_PARAMETERS");
    }
    const extraTopLevel = await tool("task_request", { recipe_id: "review", params: { scope: ["src/a.ts"] }, workflow_id: "chosen" });
    assert.equal(extraTopLevel.body.error, "INVALID_REQUEST");
    assert.equal(manager.list().length, 0, "invalid requests create no workflow");

    const submitted = { scope: ["src/a.ts", "src/b.ts"], focus: "privacy-review" };
    const requested = await tool("task_request", { recipe_id: "review", params: submitted });
    assert.equal(requested.isError, false);
    assert.equal(requested.body.state, "DRAFT");
    assert.equal(requested.body.recipe.id, "review");
    assert.equal(requested.body.recipe.digest, current.digest);
    assert.deepEqual(requested.body.resolution.category, { recipe: "review", profileKind: "review", enforced: false });
    assert.deepEqual(requested.body.resolution.capabilities, { required: [], candidateProfiles: ["reviewer"], enforced: false });
    assert.deepEqual(requested.body.resolution.cost, [{ profile: "reviewer", estimate: { basis: "unknown", reason: "NO_HISTORY" } }]);
    assert.match(requested.body.resolution.costLimit, /estimates; recipe-level USD is not enforced/);
    assert.deepEqual(requested.body.parameter_names, ["focus", "scope"]);
    const id = requested.body.workflow_id as string;
    const view = manager.status(id)!;
    assert.equal(view.state, "DRAFT");
    assert.equal(view.workflow.title, "Review privacy-review");
    assert.equal(view.workflow.description, "Review src/a.ts\nsrc/b.ts for privacy-review and report evidence.");
    assert.deepEqual(view.workflow.goals, ["Review src/a.ts\nsrc/b.ts", "Focus on privacy-review"]);
    assert.deepEqual(manager.list().map((item) => item.state), ["DRAFT"]);

    // Values are needed in the created workflow, but audits keep only keys + a digest.
    const callEvent = serverJournal.listEvents().find((event) => event.entity === "mcp_call" && event.toState === "task_request")!;
    assert.deepEqual((callEvent.data as { arg_keys: string[] }).arg_keys, ["params", "recipe_id"]);
    assert.notEqual((callEvent.data as { client: string }).client, "authenticated");
    const provenance = manager.journalOf(id)!.listEvents().find((event) => event.entity === "recipe_request")!;
    assert.equal(provenance.toState, "DRAFT");
    assert.deepEqual(provenance.entityId, "review");
    assert.deepEqual(provenance.data, {
      recipe_id: "review",
      recipe_digest: current.digest,
      params_digest: createHash("sha256").update(JSON.stringify({ scope: submitted.scope, focus: submitted.focus })).digest("hex"),
      parameter_names: ["focus", "scope"],
      required_mcp_tools: [],
      required_skills: [],
      eligible_profiles: ["reviewer"],
    });
    for (const event of [callEvent, provenance]) {
      const audit = JSON.stringify(event.data);
      for (const value of ["src/a.ts", "src/b.ts", "privacy-review"]) assert.equal(audit.includes(value), false);
    }
  });

  test("operator sees the review report, while the MCP requester gets only a non-disclosing status", async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "review-requester" }, capabilities: {} });
    const created = manager.create({
      title: "Review",
      description: "Review the implementation and keep reviewer findings private.",
      goals: ["Review completed"],
      nonGoals: [],
      conditions: [
        { id: "review", statement: "Independent review passes", required: false, checker: { kind: "review", profile: "reviewer", rubric: "Check security properties" } },
        { id: "report", statement: "A report exists", required: true, checker: { kind: "file", path: "report.md", assert: "exists" } },
      ],
    }, { id: "review-requester#session", role: "initiator" });
    assert.ok(created.ok);
    const marker = "PRIVATE_REVIEW_FINDING_7f1e";
    const journal = manager.journalOf(created.id)!;
    journal.tx((tx) => {
      tx.event(created.id, "condition_round", "1", null, "UNSATISFIED", { snapshot: "snapshot", conditions: 1 });
      tx.event(created.id, "condition", "review", null, "INFO_FAIL", {
        round: 1, statement: "Independent review passes", required: false, evidence: "secondary", checker: "review", detail: marker, snapshot: "snapshot",
      });
    });

    assert.equal(manager.status(created.id)!.conditions[0]!.detail, marker, "operator view keeps the full finding");
    const status = await tool("workflow_status", { workflow_id: created.id });
    assert.equal(status.body.conditions[0].detail, "A secondary review did not pass. Ask the operator for permitted guidance.");
    assert.doesNotMatch(JSON.stringify(status.body), new RegExp(marker));
    const events = await tool("workflow_events", { workflow_id: created.id });
    assert.doesNotMatch(JSON.stringify(events.body), new RegExp(marker));
    const operatorEvents = manager.events(created.id)!;
    assert.match(JSON.stringify(operatorEvents), new RegExp(marker), "operator event view retains the report");
  });

  test("required skills, required MCP servers, and non-draft start policies fail closed", async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "client-name-is-spoofable" }, capabilities: {} });

    addRecipe("needs-skill", recipe({ requiredSkills: [{ id: "missing-review-skill", required: true }] }));
    publish("needs-skill");
    const noSkill = await tool("task_request", { recipe_id: "needs-skill", params: { scope: ["src"] } });
    assert.equal(noSkill.body.error, "RECIPE_UNRESOLVED");
    assert.deepEqual(noSkill.body.resolution.skills.missing, ["missing-review-skill"]);

    addRecipe("needs-mcp", recipe({ requiredMcpServers: ["source-reader"], requiredMcpTools: [{ serverId: "source-reader", toolName: "read" }] }));
    publish("needs-mcp");
    const noMcp = await tool("task_request", { recipe_id: "needs-mcp", params: { scope: ["src"] } });
    assert.equal(noMcp.body.error, "RECIPE_UNRESOLVED");
    assert.deepEqual(noMcp.body.resolution.mcpServers.missing, ["source-reader"]);

    addRecipe("needs-capability", recipe({ requiredCapabilities: ["workspace.write"] }));
    publish("needs-capability");
    const noCapability = await tool("task_request", { recipe_id: "needs-capability", params: { scope: ["src"] } });
    assert.equal(noCapability.body.error, "RECIPE_UNRESOLVED");
    assert.deepEqual(noCapability.body.resolution.capabilities, { required: ["workspace.write"], candidateProfiles: [], enforced: false });

    addRecipe("bad-template", recipe({ workflow: { ...recipe().workflow, title: "Review {{undeclared}}" } }));
    publish("bad-template");
    const invalidTemplate = await tool("task_request", { recipe_id: "bad-template", params: { scope: ["src"] } });
    assert.equal(invalidTemplate.body.error, "INVALID_RECIPE_TEMPLATE");
    assert.equal(manager.list().length, 0, "an unresolved placeholder cannot leave a partial workflow behind");

    addRecipe("needs-human-gate", recipe({ startPolicy: "human_approval" }));
    publish("needs-human-gate");
    const unsupported = await tool("task_request", { recipe_id: "needs-human-gate", params: { scope: ["src"] } });
    assert.equal(unsupported.body.error, "START_POLICY_UNSUPPORTED");
    assert.equal(unsupported.body.policy, "human_approval");

    addRecipe("usd-budget", recipe({ workflow: { ...recipe().workflow, budget: { usd: 0.02 } } }));
    publish("usd-budget");
    const unbounded = await tool("task_request", { recipe_id: "usd-budget", params: { scope: ["src"] } });
    assert.equal(unbounded.body.error, "RECIPE_BUDGET_UNSUPPORTED");
    assert.match(unbounded.body.resolution.costLimit, /not enforced/);
    assert.equal(manager.list().length, 0);

    const events = serverJournal.listEvents().filter((event) => event.entity === "mcp_call" && event.toState === "task_request");
    assert.ok(events.every((event) => (event.data as { client: string }).client === "client-name-is-spoofable"));
    // clientInfo.name is a caller-supplied label, not authentication; this suite makes no identity authorization claim.
  });

  test("a recipe skill binds only when its digest exists and a granted native worker is eligible", async () => {
    const registration = {
      id: "source-reader", enabled: true, origin: "file:///review/source-reader", version: "1.0.0",
      command: process.execPath, args: [], artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "server.cjs" },
      expectedServer: { name: "source-reader", version: "1" },
      profiles: { "nemotron-worker": ["read"] }, nativeReadOnlyProfiles: { "nemotron-worker": ["read"] },
    };
    const worker = {
      id: "nemotron-worker", kinds: ["review", "write"], integration: "direct", tier: "standard", pool: null, strengths: [],
      capabilities: { capabilityIds: ["skills.injectable"], skills: "prompt-prepend" }, allowedSkillIds: [],
      cost: { basis: "unknown", reason: "NO_HISTORY" }, observed: null, enabled: true,
    } as any;
    cards = [worker];
    server = new McpServer({ manager, serverJournal, library, catalog: () => cards, mcpServers: () => [registration] as any });
    await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "skill-recipe-client" }, capabilities: {} });
    const doc = recipe({
      requiredSkills: [{ id: "review-skill", required: true }],
      requiredMcpServers: ["source-reader"],
      requiredMcpTools: [{ serverId: "source-reader", toolName: "read" }],
    });
    addRecipe("recipe-skill", doc);
    publish("recipe-skill");

    const absent = await tool("task_request", { recipe_id: "recipe-skill", params: { scope: ["src"] } });
    assert.equal(absent.body.error, "RECIPE_UNRESOLVED");
    assert.deepEqual(absent.body.resolution.skills.missing, ["review-skill"]);
    assert.equal(manager.list().length, 0);

    const skill = library.put("skills", "review-skill", { name: "Review", description: "Report risks", content: "Report one concrete risk." }, "operator").entry;
    const unauthorized = await tool("task_request", { recipe_id: "recipe-skill", params: { scope: ["src"] } });
    assert.equal(unauthorized.body.error, "RECIPE_UNRESOLVED");
    assert.deepEqual(unauthorized.body.resolution.skills.compatibleProfiles, []);
    assert.equal(manager.list().length, 0);

    worker.allowedSkillIds = ["review-skill"];
    const accepted = await tool("task_request", { recipe_id: "recipe-skill", params: { scope: ["src"] } });
    assert.equal(accepted.body.state, "DRAFT");
    assert.equal(accepted.body.resolution.skills.assignment, "required skills are bound to every write task on a compatible native worker");
    const provenance = manager.journalOf(accepted.body.workflow_id)!.listEvents().find((event) => event.entity === "recipe_request")!;
    assert.deepEqual((provenance.data as { required_skills: { id: string; digest: string }[] }).required_skills, [{ id: "review-skill", digest: skill.digest }]);
  });
});
