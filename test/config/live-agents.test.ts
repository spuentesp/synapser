import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { validateWorkflow } from "../../src/workflow/model.ts";

// Plan 17 P17.8: an agent written through the API is usable by a workflow at once, with no restart. The workflow
// manager asks the live agent list for the ids it accepts, so a review checker naming the new agent is refused before
// the write and accepted after it.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("plan 17 P17.8: a new agent is usable by a workflow without a restart", () => {
  let dir: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "live-agents-"));
    const path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const workflow = (profile: string) => ({
    id: "wf-live",
    title: "Judge with a new agent", description: "A review checker names an agent created at run time",
    goals: ["the change is judged"],
    nonGoals: [{ statement: "do not touch the README", guard: { kind: "diff", forbid: ["README.md"] } }],
    conditions: [{ id: "schema", statement: "app/schema.py was changed", checker: { kind: "diff", require: ["app/schema.py"] } }, { id: "judged", required: false, statement: "the change was judged", checker: { kind: "review", profile, rubric: "judge the change against the goals" } }],
  });
  // The manager's own check: the ids are read from the live list at call time.
  const check = (profile: string) =>
    validateWorkflow(workflow(profile), { workspaceRoot: dir, commandIds: new Set(), profileIds: new Set(live.profiles!.map((p) => p.id)) });

  test("before the write the workflow names an unknown agent and is refused", () => {
    const v = check("hot-agent");
    assert.equal(v.ok, false);
    assert.match((v as { errors: string[] }).errors.join(" "), /not a known profile/);
  });

  test("after the write, in the same process, the same workflow is accepted", () => {
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    const v = check("hot-agent");
    assert.equal(v.ok, true, JSON.stringify(v));
  });
});
