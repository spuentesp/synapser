import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_INJECTED_SKILLS, type AgentInvocation } from "../../src/agents/adapter.ts";
import { checkInjectedProvider, planInjection, type InjectedProvider } from "../../src/agents/inject.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";

// Plan 17 P17.5 and P17.3. The key value is a fake; it must reach the child's environment and nowhere else (K1).
const SECRET = "sk-test-SECRET-VALUE-0001";
const provider: InjectedProvider = { id: "p1", baseUrl: "https://models.example/v1", apiKeyEnv: "P1_KEY", model: "m-large" };
const source = { PATH: "/bin", P1_KEY: SECRET };
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

  test("claude-code and kimi are refused until the provider schema speaks the Anthropic protocol", () => {
    for (const adapter of ["claude-code", "kimi"]) {
      assert.throws(() => planInjection(adapter, provider, source), /Anthropic protocol/);
    }
  });

  test("no refusal message carries the key value", () => {
    for (const run of [() => planInjection("kimi", provider, source), () => planInjection("codex", provider, { PATH: "/bin" })]) {
      try {
        run();
        assert.fail("expected a refusal");
      } catch (error) {
        assert.equal(String(error).includes(SECRET), false);
      }
    }
  });
});
