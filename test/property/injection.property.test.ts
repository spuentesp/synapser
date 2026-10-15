import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { NO_INJECTED_SKILLS, type AgentInvocation } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { planInjection } from "../../src/agents/inject.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES } from "../../src/agents/profile.ts";
import { RUN } from "./support.ts";

// Plan 18 E3 (H3.4): for any key value, the value reaches the child environment and nowhere else (K1). This is the
// property that matters most: a key in argv, in the ledger template, or in a file is a leak.
const secret = fc.stringMatching(/^[A-Za-z0-9]{16,40}$/).map((s) => `SECRETPROP${s}`);
const profile = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id)!;

describe("H3.4 a key value never leaves the child environment (K1)", () => {
  test("for every adapter that accepts injection, the key is only in env", () => {
    fc.assert(
      fc.property(secret, (value) => {
        const source = { PATH: "/bin", P1_KEY: value };
        const oa = { id: "p1", baseUrl: "https://models.example/v1", apiKeyEnv: "P1_KEY", model: "m-large" };
        const runs: [AgentInvocation, string][] = [
          [CODEX_ADAPTER.build(profile("codex-writer"), { prompt: "p", cwd: "/w", home: "/h", envSource: source, injection: planInjection("codex", { ...oa, protocol: "openai-compatible" }, source) }, NO_INJECTED_SKILLS), "codex"],
          [MIMO_ADAPTER.build(profile("mimo-writer"), { prompt: "p", cwd: "/w", home: "/h", envSource: source, injection: planInjection("mimo", { ...oa, protocol: "openai-compatible" }, source) }, NO_INJECTED_SKILLS), "mimo"],
          [CLAUDE_CODE_ADAPTER.build(profile("claude-sonnet-writer"), { prompt: "p", cwd: "/w", home: "/h", envSource: source, injection: planInjection("claude-code", { ...oa, protocol: "anthropic" }, source) }, NO_INJECTED_SKILLS), "claude-code"],
          [KIMI_ADAPTER.build(profile("kimi-writer"), { prompt: "p", cwd: "/w", home: "/h", envSource: source, injection: planInjection("kimi", { ...oa, protocol: "anthropic" }, source) }, NO_INJECTED_SKILLS), "kimi"],
        ];
        for (const [run, name] of runs) {
          const outside = JSON.stringify({ argv: run.argv, template: run.argvTemplate, files: run.files });
          assert.equal(outside.includes(value), false, `${name}: the key left the environment`);
          assert.equal(Object.values(run.env).includes(value), true, `${name}: the key reaches the environment`);
        }
      }),
      RUN,
    );
  });
});
