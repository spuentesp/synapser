import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type AgentAdapter, type AgentInvocation, type InjectedSkills, type SkillSelection } from "../../src/agents/adapter.ts";
import { GENERIC_CLI_ADAPTER } from "../../src/agents/generic-cli.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { assertSkillPolicyUnchanged, materializeAdapterFiles, selectAuthorizedSkills, validateInjectedSkills } from "../../src/agents/skills.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import { Journal } from "../../src/journal/journal.ts";
import { BASELINE, RUN } from "../executor/env.ts";

const FAKE = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;
const content = "Always finish by checking the changed file.\n";
const skill = { id: "safe-review", digest: sha256Bytes(Buffer.from(content)), content, source: "library" as const };
const injected: InjectedSkills = { skills: [skill] };

describe("skill injection invariants L1/L2", () => {
  test("task selection is a subset of operator authority; required misses fail and recommendations may be omitted", () => {
    const authorized = [skill, { ...skill, id: "tests" }];
    const selection: SkillSelection[] = [{ id: "tests", required: true, reason: "This task changes a test contract." }];
    assert.deepEqual(selectAuthorizedSkills(authorized, selection), [{ ...authorized[1]!, selectionReason: selection[0]!.reason }]);
    assert.throws(() => selectAuthorizedSkills(authorized, [{ id: "private", required: true, reason: "must not bypass authority" }]), /not operator-authorized/);
    assert.deepEqual(selectAuthorizedSkills(authorized, [{ id: "private", required: false, reason: "optional guidance" }]), []);
    assert.deepEqual(selectAuthorizedSkills(authorized, []).map((entry) => entry.id), [], "an explicit empty selection is distinct from the legacy operator default");
    assert.deepEqual(selectAuthorizedSkills(authorized).map((entry) => entry.selectionReason), ["operator-default", "operator-default"]);
  });

  test("L1 rejects non-library, duplicate and digest-mismatched skills", () => {
    assert.throws(() => validateInjectedSkills({ skills: [{ ...skill, source: "upload" as never }] }, "native-dir"), /not from the library/);
    assert.throws(() => validateInjectedSkills({ skills: [{ ...skill, digest: sha256Bytes(Buffer.from("other")) }] }, "native-dir"), /does not match/);
    assert.throws(() => validateInjectedSkills({ skills: [skill, skill] }, "native-dir"), /duplicate/);
    assert.throws(() => validateInjectedSkills(injected, "none"), /does not support/);
  });

  test("materialisation refuses traversal and symlink parents", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-files-"));
    const worktree = join(root, "work");
    const home = join(root, "home");
    mkdirSync(worktree);
    mkdirSync(home);
    assert.throws(() => materializeAdapterFiles([], [{ root: "home", path: "../escape", content }], { worktree, home }), /unsafe|escapes/);
    symlinkSync(tmpdir(), join(home, "linked"));
    assert.throws(() => materializeAdapterFiles([], [{ root: "home", path: "linked/SKILL.md", content }], { worktree, home }), /safe directory/);
  });

  test("L2 falsification detects a permission, sandbox or budget change", () => {
    const base = { argv: ["tool", "--allowedTools", "Read", "--max-budget-usd", "1"], argvTemplate: [], env: {}, resetDirs: [], files: [] };
    const widened = { ...base, argv: ["tool", "--allowedTools", "Read,Write", "--max-budget-usd", "2"] };
    assert.throws(() => assertSkillPolicyUnchanged(base, widened), /changed/);
  });

  test("generic-cli prepends exact library content but leaves its argv template prompt-free", () => {
    const profile = {
      id: "generic", description: "test", role: "writer", adapter: "generic-cli", argv: ["tool", "{prompt}"],
      parser: "plain", timeoutMs: 1000, tags: [], enabled: true,
    } as const;
    const invocation = GENERIC_CLI_ADAPTER.build(profile, { prompt: "original", cwd: "/work", home: "/home", envSource: {} }, injected);
    assert.match(invocation.argv[1]!, /safe-review/);
    assert.match(invocation.argv[1]!, /Always finish/);
    assert.ok(invocation.argv[1]!.endsWith("original"));
    assert.deepEqual(invocation.argvTemplate, ["tool", "{prompt}"]);
  });

  test("each native mechanism targets only its isolated discovery surface", () => {
    const task = { prompt: "original", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin" } };
    const cases = [
      [CLAUDE_CODE_ADAPTER, "claude-sonnet-writer", "worktree", ".claude/skills/safe-review/SKILL.md"],
      [CODEX_ADAPTER, "codex-writer", "home", ".codex/skills/safe-review/SKILL.md"],
      [KIMI_ADAPTER, "kimi-writer", "home", ".local/share/synapser/skills/safe-review/SKILL.md"],
      [MIMO_ADAPTER, "mimo-writer", "home", ".local/share/synapser/skills/safe-review/SKILL.md"],
    ] as const;
    for (const [adapter, profileId, root, path] of cases) {
      const profile = BUILTIN_PROFILES.find((entry) => entry.id === profileId)!;
      const invocation = adapter.build(profile, task, injected);
      assert.ok(invocation.files.some((file) => file.root === root && file.path === path), adapter.id);
      assertSkillPolicyUnchanged(adapter.build(profile, task, { skills: [] }), invocation);
    }
    const kimi = KIMI_ADAPTER.build(BUILTIN_PROFILES.find((entry) => entry.id === "kimi-writer")!, task, injected);
    assert.deepEqual(kimi.argv.slice(-2), ["--skills-dir", "/isolated/home/.local/share/synapser/skills"]);
    assert.deepEqual(kimi.argvTemplate.slice(-2), ["--skills-dir", "{skillsDir}"]);
    const mimo = MIMO_ADAPTER.build(BUILTIN_PROFILES.find((entry) => entry.id === "mimo-writer")!, task, injected);
    assert.match(mimo.files.find((file) => file.path.endsWith("mimocode.jsonc"))!.content, /skills/);
  });
});

describe("runner skill audit", () => {
  let ws: string;
  let journal: Journal;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "skill-run-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    journal = Journal.open(realpathSync(mkdtempSync(join(tmpdir(), "skill-run-state-"))), RUN);
  });
  afterEach(() => journal.close());

  test("materialises only selected files in scratch and records id, digest and mechanism", async () => {
    const profile: AgentProfile = {
      id: "skill-double", description: "test", role: "writer", adapter: "generic-cli", argv: [], parser: "codex-jsonl",
      timeoutMs: 10_000, tags: [], enabled: true,
    };
    const adapter: AgentAdapter = {
      id: "generic-cli",
      displayName: "skill double",
      capabilities: {
        available: true, headless: true, structuredOutput: true, skills: "native", skillMechanism: "native-dir", mcp: false, mcpConfigInjection: false, toolAllowlist: false,
        permissionModes: [], budgetFlag: false, resume: false, cliFlags: [], profileDefinedFlags: false,
      },
      build(_profile, task, selected): AgentInvocation {
        const path = join(task.home, ".skills", selected.skills[0]?.id ?? "missing", "SKILL.md");
        return {
          argv: [process.execPath, FAKE, "skill-file", path, task.prompt],
          argvTemplate: [process.execPath, FAKE, "skill-file", "{skillFile}", "{prompt}"],
          env: { PATH: process.env["PATH"] ?? "", HOME: task.home },
          resetDirs: [{ root: "home", path: ".skills" }],
          files: selected.skills.map((entry) => ({ root: "home", path: `.skills/${entry.id}/SKILL.md`, content: entry.content })),
        };
      },
      parse(stdout, selectedProfile) {
        return GENERIC_CLI_ADAPTER.parse(stdout, selectedProfile);
      },
    };
    const result = await runAgent({ profile, adapter, injectedSkills: injected, prompt: "do it", workspaceRoot: ws, runId: RUN, taskId: "t1", journal, generation: 1 });
    const change = result.changes.find((entry) => entry.path === "skill-seen.txt")!;
    assert.equal(journal.artifacts.get(change.afterBlob!).toString(), content);
    assert.equal(existsSync(join(ws, "skill-seen.txt")), false, "the real workspace and HOME remain untouched");
    const expected = [{ id: skill.id, digest: skill.digest, mechanism: "native-dir", reason: "operator-default" }];
    assert.deepEqual(result.skills, expected);
    assert.deepEqual(journal.listAgentRuns()[0]?.skills, expected);
    const event = journal.listEvents().find((entry) => entry.entity === "agent_run")!;
    assert.deepEqual((event.data as { skills: unknown }).skills, expected);
  });
});
