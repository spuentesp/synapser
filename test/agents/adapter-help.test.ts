// L5 has two independent witnesses: constructed invocations cannot escape the declared flag table,
// and every declaration must occur in the installed binary's real help. Missing CLIs are omissions.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { type AgentAdapter, type AgentInvocation, type InjectedSkills } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { sha256Bytes } from "../../src/digest/file.ts";

const content = "Check the result.\n";
const injected: InjectedSkills = {
  skills: [{ id: "check-result", content, digest: sha256Bytes(Buffer.from(content)), source: "library" }],
};
const task = { prompt: "do it", cwd: "/isolated/work", home: "/isolated/home", envSource: { PATH: "/bin" } };

interface Case {
  adapter: AgentAdapter;
  profileId: string;
  help: readonly string[];
  variants(profile: AgentProfile): readonly AgentInvocation[];
}

const withFields = (profile: AgentProfile, fields: Partial<AgentProfile>): AgentProfile => ({ ...profile, ...fields });
const build = (adapter: AgentAdapter, profile: AgentProfile, selected: InjectedSkills = { skills: [] }) => adapter.build(profile, task, selected);
const cases: readonly Case[] = [
  {
    adapter: CLAUDE_CODE_ADAPTER, profileId: "claude-sonnet-writer", help: ["--help"],
    variants: (p) => [build(CLAUDE_CODE_ADAPTER, p), build(CLAUDE_CODE_ADAPTER, withFields(p, { permissions: { allowedTools: ["Read"], disallowedTools: ["Write"], mode: "plan" } }))],
  },
  {
    adapter: CODEX_ADAPTER, profileId: "codex-writer", help: ["exec", "--help"],
    variants: (p) => [build(CODEX_ADAPTER, withFields(p, { model: "test-model" }))],
  },
  {
    adapter: KIMI_ADAPTER, profileId: "kimi-writer", help: ["--help"],
    variants: (p) => [
      build(KIMI_ADAPTER, withFields(p, { permissions: { mode: "yolo" } }), injected),
      build(KIMI_ADAPTER, withFields(p, { permissions: { mode: "plan" } })),
    ],
  },
  {
    adapter: MIMO_ADAPTER, profileId: "mimo-writer", help: ["run", "--help"],
    variants: (p) => [build(MIMO_ADAPTER, withFields(p, { model: "provider/model", permissions: { mode: "yolo" } }), injected)],
  },
];

const emittedFlags = (invocations: readonly AgentInvocation[]): string[] =>
  [...new Set(invocations.flatMap((invocation) => invocation.argv.filter((arg) => /^-{1,2}[A-Za-z]/.test(arg))))].sort();

describe("adapter flag invariant L5", () => {
  for (const entry of cases) {
    test(`${entry.adapter.id}: every emitted flag is declared`, () => {
      const profile = BUILTIN_PROFILES.find((candidate) => candidate.id === entry.profileId)!;
      assert.equal(entry.adapter.capabilities.profileDefinedFlags, false);
      assert.deepEqual(emittedFlags(entry.variants(profile)), [...entry.adapter.capabilities.cliFlags].sort());
    });

    test(`${entry.adapter.id}: declared flags exist in the real --help`, (t) => {
      const executable = entry.adapter.id === "claude-code" ? "claude" : entry.adapter.id;
      const result = spawnSync(executable, entry.help, { encoding: "utf8", timeout: 10_000 });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        t.skip(`${executable} is not installed`);
        return;
      }
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, result.stderr);
      const help = `${result.stdout}\n${result.stderr}`;
      for (const flag of entry.adapter.capabilities.cliFlags) assert.ok(help.includes(flag), `${executable} help does not contain ${flag}`);
    });
  }
});
