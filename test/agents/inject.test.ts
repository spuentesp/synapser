import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS, type AgentInvocation } from "../../src/agents/adapter.ts";
import { checkInjectedProvider, planInjection, providerForRun, type InjectedProvider } from "../../src/agents/inject.ts";
import { validateProfile } from "../../src/agents/profile.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { validateProviderConfig, validateRoleConfig } from "../../src/model/config.ts";

// Plan 17 P17.5 and P17.3. The key value is a fake; it must reach the child's environment and nowhere else (K1).
const SECRET = "sk-test-SECRET-VALUE-0001";
const provider: InjectedProvider = { id: "p1", baseUrl: "https://models.example/v1", apiKeyEnv: "P1_KEY", model: "m-large", protocol: "openai-compatible" };
const anthropic: InjectedProvider = { id: "a1", baseUrl: "https://anthropic.example", apiKeyEnv: "A1_KEY", model: "claude-x", protocol: "anthropic" };
const source = { PATH: "/bin", P1_KEY: SECRET, A1_KEY: SECRET };
const profile = (id: string): AgentProfile => BUILTIN_PROFILES.find((p) => p.id === id)!;
const task = (injection?: ReturnType<typeof planInjection>) => ({ prompt: "p", cwd: "/w", home: "/h", envSource: source, ...(injection ? { injection } : {}) });

function assertNoSecret(invocation: AgentInvocation): void {
  const outside = JSON.stringify({ argv: invocation.argv, template: invocation.argvTemplate, files: invocation.files });
  assert.equal(outside.includes(SECRET), false, "the key value must not appear in argv, the ledger template or a file");
}

describe("P17.5: codex receives the provider through -c overrides", () => {
  test("the provider, its endpoint and its key variable name go in argv; the key value only in env", () => {
    const invocation = CODEX_ADAPTER.build(profile("codex-writer"), task(planInjection("codex", provider, source)), NO_INJECTED_SKILLS);
    assert.ok(invocation.argv.includes('model_provider="p1"'));
    assert.ok(invocation.argv.some((a) => a.includes('env_key="P1_KEY"') && a.includes('base_url="https://models.example/v1"')));
    assert.equal(invocation.argv.filter((a) => a === "-m").length, 1, "the injected model replaces the profile's model");
    assert.equal(invocation.argv[invocation.argv.indexOf("-m") + 1], "m-large");
    assert.equal(invocation.env["P1_KEY"], SECRET);
    assertNoSecret(invocation);
  });
});

describe("P17.5: mimo keeps the key in its environment and names it as {env:...} in its configuration", () => {
  test("the configuration references the variable, never the value", () => {
    const invocation = MIMO_ADAPTER.build(profile("mimo-writer"), task(planInjection("mimo", provider, source)), NO_INJECTED_SKILLS);
    const file = invocation.files.find((f) => f.path === ".config/mimocode/mimocode.jsonc");
    assert.ok(file, "the configuration file is written");
    const json = JSON.parse(file.content);
    assert.equal(json.provider.p1.options.apiKey, "{env:P1_KEY}");
    assert.equal(json.provider.p1.options.baseURL, "https://models.example/v1");
    assert.ok(invocation.argv.includes("p1/m-large"));
    assert.equal(invocation.env["P1_KEY"], SECRET);
    assertNoSecret(invocation);
  });

  test("the provider and the skill paths share one configuration file", () => {
    const skill = { id: "s1", digest: "d1", content: "# skill", source: "library" as const };
    const invocation = MIMO_ADAPTER.build(profile("mimo-writer"), task(planInjection("mimo", provider, source)), { skills: [skill] });
    const files = invocation.files.filter((f) => f.path === ".config/mimocode/mimocode.jsonc");
    assert.equal(files.length, 1);
    const json = JSON.parse(files[0]!.content);
    assert.ok(json.skills.paths[0].endsWith(".local/share/synapser/skills"));
    assert.equal(json.provider.p1.options.apiKey, "{env:P1_KEY}");
  });
});

describe("P17.5: claude-code receives an Anthropic-protocol provider through its environment", () => {
  test("the endpoint and the key go in the environment; the model flag replaces the profile's model", () => {
    const invocation = CLAUDE_CODE_ADAPTER.build(profile("claude-sonnet-writer"), task(planInjection("claude-code", anthropic, source)), NO_INJECTED_SKILLS);
    assert.equal(invocation.env["ANTHROPIC_BASE_URL"], "https://anthropic.example");
    assert.equal(invocation.env["ANTHROPIC_API_KEY"], SECRET);
    assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "claude-x");
    assert.equal(invocation.argv.filter((a) => a === "--model").length, 1);
    assertNoSecret(invocation);
  });
});

describe("P17.5: kimi receives an Anthropic-protocol provider through its config.toml", () => {
  test("the file declares the provider and the model by variable name; -m selects the alias", () => {
    const invocation = KIMI_ADAPTER.build(profile("kimi-writer"), task(planInjection("kimi", anthropic, source)), NO_INJECTED_SKILLS);
    const file = invocation.files.find((f) => f.path === ".kimi-code/config.toml");
    assert.ok(file, "the kimi configuration is written under the run HOME");
    assert.ok(file.content.includes('default_model = "a1/claude-x"'));
    assert.ok(file.content.includes('type = "anthropic"'));
    assert.ok(file.content.includes('api_key_env = "A1_KEY"'));
    assert.equal(invocation.argv[invocation.argv.indexOf("-m") + 1], "a1/claude-x");
    assert.equal(invocation.env["A1_KEY"], SECRET);
    assertNoSecret(invocation);
  });
});

describe("P17.3: kimi passes the profile's model as -m", () => {
  test("a profile with a model adds -m; a profile without one does not", () => {
    const withModel = KIMI_ADAPTER.build({ ...profile("kimi-writer"), model: "m1" }, task(), NO_INJECTED_SKILLS);
    assert.equal(withModel.argv[withModel.argv.indexOf("-m") + 1], "m1");
    assert.equal(withModel.argvTemplate[withModel.argvTemplate.indexOf("-m") + 1], "m1");
    const without = KIMI_ADAPTER.build(profile("kimi-writer"), task(), NO_INJECTED_SKILLS);
    assert.equal(without.argv.includes("-m"), false);
  });
});

describe("P17.5: what is refused", () => {
  test("each CLI accepts only the protocol it speaks", () => {
    assert.throws(() => planInjection("claude-code", provider, source), /claude-code needs an anthropic provider/);
    assert.throws(() => planInjection("kimi", provider, source), /kimi needs an anthropic provider/);
    assert.throws(() => planInjection("codex", anthropic, source), /codex needs an openai-compatible provider/);
    assert.throws(() => planInjection("mimo", anthropic, source), /mimo needs an openai-compatible provider/);
  });

  test("a reserved Synapser variable cannot hold a provider key (K6)", () => {
    assert.throws(() => checkInjectedProvider({ ...provider, apiKeyEnv: "SYNAPSER_OPERATOR_TOKEN" }), /reserved by Synapser/);
  });

  test("cloud metadata addresses are refused, bare or inside a URL (K7)", () => {
    for (const baseUrl of ["http://169.254.169.254/latest", "http://[fd00:ec2::254]/"]) {
      assert.throws(() => checkInjectedProvider({ ...provider, baseUrl }), /metadata/);
    }
  });

  test("a non-http endpoint, a malformed id and a model id that a flag cannot carry are refused", () => {
    assert.throws(() => checkInjectedProvider({ ...provider, baseUrl: "file:///etc/passwd" }), /http or https/);
    assert.throws(() => checkInjectedProvider({ ...provider, id: "Bad Id" }), /lowercase slug/);
    assert.throws(() => checkInjectedProvider({ ...provider, model: "m large" }), /characters/);
  });

  test("an unset key variable is refused, and the message names only the variable", () => {
    assert.throws(() => planInjection("codex", provider, { PATH: "/bin" }), /P1_KEY is not set/);
  });

  test("no refusal message carries the key value", () => {
    for (const run of [() => planInjection("kimi", provider, source), () => planInjection("codex", anthropic, source)]) {
      try {
        run();
        assert.fail("expected a refusal");
      } catch (error) {
        assert.equal(String(error).includes(SECRET), false);
      }
    }
  });
});

describe("plan 17: the protocol is accepted in the schema and kept off the OpenAI-compatible path", () => {
  const base = { baseUrl: "https://anthropic.example", apiKeyEnv: ["A1_KEY"], models: [{ id: "claude-x" }] };

  test("the provider validator accepts the anthropic protocol and still refuses unknown ones", () => {
    assert.deepEqual(validateProviderConfig("a1", { protocol: "anthropic", ...base }), []);
    assert.match(validateProviderConfig("a1", { protocol: "grpc", ...base }).join(" "), /unsupported protocol/);
  });

  test("a role cannot run on an anthropic-protocol provider", () => {
    const providers = { a1: { protocol: "anthropic" as const, ...base } };
    assert.match(validateRoleConfig("supervisor", { provider: "a1", model: "claude-x" }, providers).join(" "), /roles need an openai-compatible provider/);
  });
});

describe("plan 17: library providers stay openai-compatible", () => {
  test("a library document cannot declare the anthropic protocol", async () => {
    const { validateLibraryDocument } = await import("../../src/library/validate.ts");
    const problems = validateLibraryDocument("providers", "a1", { protocol: "anthropic", baseUrl: "https://anthropic.example", apiKeyEnv: ["A1_KEY"], models: [{ id: "claude-x" }] });
    assert.match(problems.join(" "), /provider a1: unsupported protocol anthropic/);
  });
});

describe("plan 17 P17.6: a profile names its operator provider; the run resolves it or refuses", () => {
  const providers = { p1: { protocol: "openai-compatible" as const, baseUrl: "https://models.example/v1", apiKeyEnv: ["MISSING_KEY", "P1_KEY"], models: [{ id: "m-large" }] } };

  test("the first key variable that is set is used; the model must be declared", () => {
    const resolved = providerForRun("w1", "p1", "m-large", providers, { P1_KEY: SECRET });
    assert.equal(resolved.apiKeyEnv, "P1_KEY");
    assert.equal(resolved.protocol, "openai-compatible");
    assert.throws(() => providerForRun("w1", "p1", "other", providers, { P1_KEY: SECRET }), /not declared by provider p1/);
    assert.throws(() => providerForRun("w1", "nope", "m-large", providers, { P1_KEY: SECRET }), /unknown provider nope/);
  });

  test("no key variable set is refused, and the message names the variables, never a value", () => {
    assert.throws(() => providerForRun("w1", "p1", "m-large", providers, {}), /MISSING_KEY \/ P1_KEY is not set|none of MISSING_KEY \/ P1_KEY/);
  });

  test("validateProfile accepts injectProvider on a CLI agent with a model, and refuses it elsewhere", () => {
    const cli = BUILTIN_PROFILES.find((p) => p.id === "codex-writer")!;
    assert.deepEqual(validateProfile({ ...cli, injectProvider: "p1", model: "m-large" }), []);
    assert.match(validateProfile({ ...cli, injectProvider: "p1" }).join(" "), /needs the model/);
    const oneshot = BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!;
    assert.match(validateProfile({ ...oneshot, adapter: "cli-oneshot", argv: ["x", "{prompt}"], injectProvider: "p1", model: "m" } as AgentProfile).join(" "), /only valid for/);
  });

  test("a library document cannot set injectProvider over a CLI base", async () => {
    const { validateLibraryDocument } = await import("../../src/library/validate.ts");
    assert.ok(validateLibraryDocument("agents", "w1", { extends: "codex-writer", injectProvider: "p1", model: "m-large" }).length > 0);
  });
});
