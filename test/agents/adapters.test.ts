import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
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

describe("CodexAdapter", () => {
  test("pins CODEX_HOME to the disposable HOME and builds sandbox policy from the profile", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "codex-writer")!;
    const invocation = CODEX_ADAPTER.build(
      profile,
      { prompt: "fix one thing", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin", HOME: "/real/home", CODEX_HOME: "/real/codex" } },
      NO_INJECTED_SKILLS,
    );
    assert.deepEqual(invocation.argv, [
      "codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      "-s", "workspace-write", "-C", "/isolated/work", "fix one thing",
    ]);
    assert.equal(invocation.env["HOME"], "/isolated/home");
    assert.equal(invocation.env["CODEX_HOME"], "/isolated/home/.codex");
    assert.equal(invocation.argvTemplate.at(-1), "{prompt}");
  });

  test("uses the Codex parser and refuses controls the CLI cannot enforce", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "codex-advisor")!;
    assert.equal(CODEX_ADAPTER.parse(fixture("codex.jsonl"), profile).outcome, "SUCCEEDED");
    assert.deepEqual(CODEX_ADAPTER.capabilities.permissionModes, ["read-only", "workspace-write"]);
    assert.equal(CODEX_ADAPTER.capabilities.budgetFlag, false);
    assert.ok(validateProfile({ ...profile, permissions: { mode: "danger-full-access" } }).some((problem) => /codex permission mode/.test(problem)));
    assert.ok(validateProfile({ ...profile, maxBudgetUsd: 1 }).some((problem) => /no per-run USD budget/.test(problem)));
  });
});

describe("KimiAdapter", () => {
  test("builds stream-json headless mode and declares native skills-dir support", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "kimi-writer")!;
    const invocation = KIMI_ADAPTER.build(
      profile,
      { prompt: "fix one thing", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin", HOME: "/real/home" } },
      NO_INJECTED_SKILLS,
    );
    assert.deepEqual(invocation.argv, ["kimi", "-p", "fix one thing", "--output-format", "stream-json"]);
    assert.equal(invocation.env["HOME"], "/isolated/home");
    assert.equal(KIMI_ADAPTER.capabilities.skills, "native");
    assert.equal(KIMI_ADAPTER.capabilities.skillMechanism, "skills-dir-flag");
    assert.deepEqual(KIMI_ADAPTER.capabilities.permissionModes, ["default", "yolo", "plan"]);
  });

  test("uses the captured session log parser and rejects unsupported controls", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "kimi-writer")!;
    const parsed = KIMI_ADAPTER.parse(fixture("kimi.stream.jsonl"), profile, { kimi: { wireText: fixture("kimi.wire.jsonl") }, home: "/isolated/home" });
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.usage.provenance, "log");
    assert.ok(validateProfile({ ...profile, permissions: { mode: "auto" } }).some((problem) => /kimi permission mode/.test(problem)));
    assert.ok(validateProfile({ ...profile, maxBudgetUsd: 1 }).some((problem) => /no per-run USD budget/.test(problem)));
  });
});

describe("MimoAdapter", () => {
  test("builds a pure headless invocation and declares the installed native skills mechanism", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "mimo-writer")!;
    const invocation = MIMO_ADAPTER.build(
      profile,
      { prompt: "fix one thing", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin", HOME: "/real/home" } },
      NO_INJECTED_SKILLS,
    );
    assert.deepEqual(invocation.argv, ["mimo", "run", "fix one thing", "--format", "json", "--pure", "--dir", "/isolated/work"]);
    assert.equal(invocation.env["HOME"], "/isolated/home");
    assert.equal(MIMO_ADAPTER.capabilities.skillMechanism, "native-dir");
  });

  test("parses the captured 402 as failure and rejects controls MiMo cannot enforce", () => {
    const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === "mimo-writer")!;
    const parsed = MIMO_ADAPTER.parse(fixture("mimo-error.jsonl"), profile);
    assert.equal(parsed.outcome, "FAILED");
    assert.match(parsed.reason ?? "", /402/);
    assert.ok(validateProfile({ ...profile, permissions: { mode: "never-ask" } }).some((problem) => /mimo permission mode/.test(problem)));
    assert.ok(validateProfile({ ...profile, maxBudgetUsd: 1 }).some((problem) => /no per-run USD budget/.test(problem)));
  });
});
