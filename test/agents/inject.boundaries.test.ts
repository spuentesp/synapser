import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS } from "../../src/agents/adapter.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { checkInjectedProvider, type InjectedProvider, planInjection, providerForRun } from "../../src/agents/inject.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES } from "../../src/agents/profile.ts";

// Plan 18 E4 (H4.4): the boundaries and the exact outputs that mutation testing showed were not pinned. Each refusal
// and each emitted configuration is a contract the operator and the CLIs depend on.
const base: InjectedProvider = { id: "p1", baseUrl: "https://models.example/v1", apiKeyEnv: "P1_KEY", model: "m-large", protocol: "openai-compatible" };
const ok = (over: Partial<InjectedProvider>) => assert.doesNotThrow(() => checkInjectedProvider({ ...base, ...over }));
const refused = (over: Partial<InjectedProvider>, message: RegExp) => assert.throws(() => checkInjectedProvider({ ...base, ...over }), message);

describe("provider id: lowercase slug, 1 to 64 characters", () => {
  test("the edges are accepted and refused where the contract says", () => {
    ok({ id: "a" });
    ok({ id: "a-b" });
    ok({ id: "a".repeat(64) });
    refused({ id: "-a" }, /lowercase slug/);
    refused({ id: "A" }, /lowercase slug/);
    refused({ id: "a".repeat(65) }, /lowercase slug/);
  });
});

describe("key variable name: upper case, 1 to 64 characters, not reserved", () => {
  test("the edges are accepted and refused", () => {
    ok({ apiKeyEnv: "A" });
    ok({ apiKeyEnv: "_A" });
    ok({ apiKeyEnv: "A".repeat(64) });
    refused({ apiKeyEnv: "1A" }, /environment variable name/);
    refused({ apiKeyEnv: "a" }, /environment variable name/);
    refused({ apiKeyEnv: "A".repeat(65) }, /environment variable name/);
    refused({ apiKeyEnv: "SYNAPSER_X" }, /reserved by Synapser/);
  });
});

describe("model id: 1 to 200 characters of letters, digits and . _ : / -", () => {
  test("the edges and the allowed symbols", () => {
    ok({ model: "m/x:1.2_3-4" });
    ok({ model: "m".repeat(200) });
    refused({ model: "m x" }, /characters a CLI flag cannot carry/);
    refused({ model: "m".repeat(201) }, /characters a CLI flag cannot carry/);
  });
});

describe("endpoint: http or https, and no metadata address in any spelling", () => {
  test("loopback and public endpoints are accepted", () => {
    ok({ baseUrl: "http://127.0.0.1:4194" });
    ok({ baseUrl: "http://models.example" });
  });
  test("other schemes, and things that are not URLs, are refused", () => {
    refused({ baseUrl: "ftp://models.example" }, /http or https/);
    refused({ baseUrl: "not a url" }, /not a URL/);
  });
  test("every metadata spelling is refused", () => {
    for (const u of ["http://169.254.169.254", "http://metadata", "http://metadata.google.internal", "http://[fd00:ec2::254]"]) {
      refused({ baseUrl: u }, /cloud metadata address/);
    }
  });
});

describe("the emitted configuration is exact", () => {
  const source = { PATH: "/bin", P1_KEY: "sk-test-exact-0001" };
  const task = (injection: ReturnType<typeof planInjection>) => ({ prompt: "p", cwd: "/w", home: "/h", envSource: source, injection });

  test("kimi's config.toml declares the provider, the key variable name and the model, and nothing else", () => {
    const plan = planInjection("kimi", { ...base, protocol: "anthropic" }, source);
    const expected = [
      'default_model = "p1/m-large"',
      "",
      "[providers.p1]",
      'base_url = "https://models.example/v1"',
      'type = "anthropic"',
      'api_key_env = "P1_KEY"',
      "",
      '[models."p1/m-large"]',
      'provider = "p1"',
      'model = "m-large"',
      "max_context_size = 100000",
      "max_output_size = 4096",
      "capabilities = []",
      'display_name = "m-large"',
      "",
    ].join("\n");
    assert.equal(plan.homeFiles![0]!.content, expected);
    assert.deepEqual(plan.argv, ["-m", "p1/m-large"]);
    const run = KIMI_ADAPTER.build(BUILTIN_PROFILES.find((p) => p.id === "kimi-writer")!, task(plan), NO_INJECTED_SKILLS);
    assert.equal(run.files.find((f) => f.path === ".kimi-code/config.toml")!.content, expected);
  });

  test("mimo's configuration names the key through {env:...} and nothing else", () => {
    const plan = planInjection("mimo", base, source);
    assert.deepEqual(plan.homeJson!.value, {
      provider: { p1: { npm: "@ai-sdk/openai-compatible", name: "p1", options: { baseURL: "https://models.example/v1", apiKey: "{env:P1_KEY}" }, models: { "m-large": { name: "m-large" } } } },
    });
    assert.deepEqual(plan.argv, ["--model", "p1/m-large"]);
    const run = MIMO_ADAPTER.build(BUILTIN_PROFILES.find((p) => p.id === "mimo-writer")!, task(plan), NO_INJECTED_SKILLS);
    assert.equal(run.argv[run.argv.indexOf("--model") + 1], "p1/m-large");
  });

  test("claude-code gets the endpoint without /v1/messages, the key in env, and the model flag", () => {
    const plan = planInjection("claude-code", { ...base, protocol: "anthropic", baseUrl: "https://anthropic.example" }, source);
    assert.deepEqual(plan.env, { P1_KEY: "sk-test-exact-0001", ANTHROPIC_BASE_URL: "https://anthropic.example", ANTHROPIC_API_KEY: "sk-test-exact-0001" });
    assert.deepEqual(plan.argv, ["--model", "m-large"]);
    const run = CLAUDE_CODE_ADAPTER.build(BUILTIN_PROFILES.find((p) => p.id === "claude-sonnet-writer")!, task(plan), NO_INJECTED_SKILLS);
    assert.equal(run.env["ANTHROPIC_BASE_URL"], "https://anthropic.example");
  });

  test("an adapter that takes no injection is refused by name", () => {
    assert.throws(() => planInjection("cli-oneshot", base, source), { message: "no provider injection for adapter cli-oneshot" });
  });
});

describe("the remaining mutation gaps (plan 18 E4)", () => {
  const source = { PATH: "/bin", P1_KEY: "sk-test-gap-0001" };

  test("planInjection itself refuses a provider the checks refuse, not only checkInjectedProvider", () => {
    assert.throws(() => planInjection("codex", { ...base, id: "Bad Id" }, source), /lowercase slug/);
    assert.throws(() => planInjection("mimo", { ...base, baseUrl: "http://169.254.169.254" }, source), /cloud metadata address/);
  });

  test("codex receives its flags exactly, one -c per override, and the model after them", () => {
    const plan = planInjection("codex", base, source);
    assert.deepEqual(plan.argv, [
      "-c", 'model_provider="p1"',
      "-c", 'model_providers.p1={name="p1",base_url="https://models.example/v1",env_key="P1_KEY",wire_api="responses"}',
      "-m", "m-large",
    ]);
  });

  test("mimo's configuration file path is the one mimo reads", () => {
    assert.equal(planInjection("mimo", base, source).homeJson!.path, ".config/mimocode/mimocode.jsonc");
  });
});

describe("providerForRun: the model must be one the provider declares, from several", () => {
  test("any declared model is accepted; an undeclared one is refused", () => {
    const providers = { p1: { protocol: "openai-compatible" as const, baseUrl: "https://models.example/v1", apiKeyEnv: ["P1_KEY"], models: [{ id: "m1" }, { id: "m2" }] } };
    const source = { P1_KEY: "sk-test-run-0001" };
    assert.equal(providerForRun("w", "p1", "m1", providers, source).model, "m1");
    assert.equal(providerForRun("w", "p1", "m2", providers, source).model, "m2");
    assert.throws(() => providerForRun("w", "p1", "m3", providers, source), /model m3 is not declared by provider p1/);
  });
});
