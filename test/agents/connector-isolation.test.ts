import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS } from "../../src/agents/adapter.ts";
import { buildAgentEnv } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { planInjection } from "../../src/agents/inject.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";

// Plan 17 P17.8 K6: no CLI is ever given the configuration connector. Its token, its URL and its tool names must not
// appear in anything a CLI receives: the environment it inherits, its argv, its ledger template, or its files.
const CONNECTOR_TOKEN = "operator-token-CONNECTOR-SECRET-0123456789";
const CONNECTOR_URL = "http://127.0.0.1:47999";
const source = { PATH: "/bin", HOME: "/home/op", SYNAPSER_OPERATOR_TOKEN: CONNECTOR_TOKEN, SYNAPSER_API_URL: CONNECTOR_URL, P1_KEY: "sk-test-K6-value" };
const provider = { id: "p1", baseUrl: "https://models.example/v1", apiKeyEnv: "P1_KEY", model: "m-large", protocol: "openai-compatible" as const };
const anthropic = { ...provider, id: "a1", protocol: "anthropic" as const, model: "claude-x" };
const task = (injection?: ReturnType<typeof planInjection>) => ({ prompt: "p", cwd: "/w", home: "/h", envSource: source, ...(injection ? { injection } : {}) });
const profile = (id: string): AgentProfile => BUILTIN_PROFILES.find((p) => p.id === id)!;

const leaks = (text: string): string[] => [CONNECTOR_TOKEN, CONNECTOR_URL, "config_put_", "/api/config"].filter((needle) => text.includes(needle));

describe("plan 17 P17.8 K6: the configuration connector reaches no CLI", () => {
  test("the environment a CLI inherits never carries the operator token or the API URL", () => {
    const env = buildAgentEnv(profile("codex-writer"), source, "/h");
    assert.deepEqual(leaks(JSON.stringify(env)), []);
    assert.equal("SYNAPSER_OPERATOR_TOKEN" in env, false);
    assert.equal("SYNAPSER_API_URL" in env, false);
  });

  test("no injected CLI receives the connector anywhere, in argv, template, env or files", () => {
    const runs = [
      CLAUDE_CODE_ADAPTER.build(profile("claude-sonnet-writer"), task(planInjection("claude-code", anthropic, source)), NO_INJECTED_SKILLS),
      KIMI_ADAPTER.build(profile("kimi-writer"), task(planInjection("kimi", anthropic, source)), NO_INJECTED_SKILLS),
      CODEX_ADAPTER.build(profile("codex-writer"), task(planInjection("codex", provider, source)), NO_INJECTED_SKILLS),
      MIMO_ADAPTER.build(profile("mimo-writer"), task(planInjection("mimo", provider, source)), NO_INJECTED_SKILLS),
    ];
    for (const run of runs) {
      assert.deepEqual(leaks(JSON.stringify({ argv: run.argv, template: run.argvTemplate, env: run.env, files: run.files })), []);
    }
  });
});
