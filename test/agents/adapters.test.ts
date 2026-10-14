import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { BUILTIN_PROFILES, validateProfile } from "../../src/agents/profile.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/cli/${name}`, import.meta.url), "utf8");

describe("ClaudeCodeAdapter", () => {
  test("builds the headless invocation from explicit model, permission and budget profile fields", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "claude-sonnet-writer")!;
    const invocation = CLAUDE_CODE_ADAPTER.build(
      profile,
      { prompt: "fix one thing", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin", NEBIUS_TOKEN: "never-copy" } },
      NO_INJECTED_SKILLS,
    );

    assert.deepEqual(invocation.argv, [
      "claude", "-p", "fix one thing", "--output-format", "json", "--model", "sonnet",
      "--allowedTools", "Read,Glob,Grep,Edit,Write", "--max-budget-usd", "1",
    ]);
    assert.deepEqual(invocation.argvTemplate.slice(0, 3), ["claude", "-p", "{prompt}"]);
    assert.equal(invocation.env["HOME"], "/isolated/home");
    assert.equal("NEBIUS_TOKEN" in invocation.env, false);
    assert.deepEqual(invocation.files, []);
  });

  test("uses the Claude parser and declares the controls it can enforce", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "claude-opus-advisor")!;
    const parsed = CLAUDE_CODE_ADAPTER.parse(fixture("claude.json"), profile);
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.finalText, "OK");
    assert.equal(CLAUDE_CODE_ADAPTER.capabilities.skills, "native");
    assert.equal(CLAUDE_CODE_ADAPTER.capabilities.budgetFlag, true);
    assert.ok(CLAUDE_CODE_ADAPTER.capabilities.permissionModes.includes("plan"));
  });

  test("rejects unsafe advisor permissions and invalid budgets as profile data", () => {
    const advisor = BUILTIN_PROFILES.find((candidate) => candidate.id === "claude-opus-advisor")!;
    assert.ok(validateProfile({ ...advisor, permissions: { allowedTools: ["Read", "Write"] } }).some((problem) => /advisor/.test(problem)));
    assert.ok(validateProfile({ ...advisor, permissions: { mode: "bypassPermissions" } }).some((problem) => /advisor/.test(problem)));
    assert.ok(validateProfile({ ...advisor, maxBudgetUsd: 0 }).some((problem) => /maxBudgetUsd/.test(problem)));
  });
});
