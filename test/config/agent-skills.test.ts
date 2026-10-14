import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

// Plan 14 Q5.4 (decision D6): the operator's file decides which library skills each agent receives, at most five each.

function load(raw: object) {
  const root = mkdtempSync(join(tmpdir(), "agent-skills-"));
  const path = join(root, "c.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "s"), research: false, ...raw }));
  return loadConfig({ path });
}

describe("the agent skills the operator's file assigns (plan 14 Q5.4, D6)", () => {
  test("by default no agent receives a library skill", () => {
    assert.deepEqual(load({}).agentSkills, {});
  });

  test("the file's assignments are kept, without duplicates", () => {
    assert.deepEqual(load({ agentSkills: { "lib-reviewer": ["style", "style", "tests"] } }).agentSkills, { "lib-reviewer": ["style", "tests"] });
  });

  test("more than five skills for one agent refuses the whole file", () => {
    assert.throws(() => load({ agentSkills: { "lib-reviewer": ["a", "b", "c", "d", "e", "f"] } }), (e: unknown) => e instanceof ConfigError && /at most 5 skills per agent/.test(e.errors.join("\n")));
  });

  test("an agent id or a skill id that is not a slug refuses the whole file", () => {
    assert.throws(() => load({ agentSkills: { "Bad Agent": ["style"] } }), (e: unknown) => e instanceof ConfigError && /is not an agent id/.test(e.errors.join("\n")));
    assert.throws(() => load({ agentSkills: { "lib-reviewer": ["Not A Skill"] } }), (e: unknown) => e instanceof ConfigError && /must be a list of skill ids/.test(e.errors.join("\n")));
  });
});
