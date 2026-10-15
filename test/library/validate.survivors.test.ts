import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultModelConfig } from "../../src/model/config.ts";
import { libraryPolicyOf, NO_LIBRARY_POLICY, providerOfAgent, validateLibraryDocument } from "../../src/library/validate.ts";

// Plan 18 E4 (H4.1, library validator): the branches and messages the mutation run left alive. Each assertion is the whole
// list of problems for one document, so a changed message, a lost problem or an extra one fails the test.
const POLICY = { ...NO_LIBRARY_POLICY, providerKeyEnv: ["OPENAI_KEY"] };
/** The policy a loaded configuration implies, with the built-in providers, as the server builds it. */
const libraryPolicy = () => libraryPolicyOf({ providers: defaultModelConfig().providers, providerKeyEnv: [], profiles: [] });
const PROVIDER = { protocol: "openai-compatible", baseUrl: "https://ok.example/v1/", apiKeyEnv: ["OPENAI_KEY"], models: [{ id: "m" }] };

describe("library providers: each rule gives its own message", () => {
  test("a valid provider has no problem", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", PROVIDER, POLICY), []);
  });

  test("a key name outside the operator's allowlist is named", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, apiKeyEnv: ["OTHER_KEY"] }, POLICY), [
      "providers/p1: apiKeyEnv OTHER_KEY is not in providerKeyEnv (the operator's allowlist in synapser.config.json)",
    ]);
  });

  test("apiKeyEnv that is not a list of names is refused as a shape", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, apiKeyEnv: "OPENAI_KEY" }, POLICY), [
      "provider p1: apiKeyEnv must contain environment variable names",
    ]);
  });

  test("a metadata address written in brackets is still recognised as private", () => {
    const problems = validateLibraryDocument("providers", "p1", { ...PROVIDER, baseUrl: "http://[fd00:ec2::254]/" }, POLICY);
    assert.deepEqual(problems, [
      "provider p1: baseUrl must be https (or loopback for tests)",
      "providers/p1: baseUrl fd00:ec2::254 is a private address; a library provider may not reach it (plan 15 D3)",
    ]);
  });

  test("an IPv4 metadata address is recognised as private", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, baseUrl: "http://169.254.169.254/" }, POLICY), [
      "provider p1: baseUrl must be https (or loopback for tests)",
      "providers/p1: baseUrl 169.254.169.254 is a private address; a library provider may not reach it (plan 15 D3)",
    ]);
  });

  test("a document id that differs from the id it is filed under is refused", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, id: "zz" }, POLICY), ["providers/p1: document id \"zz\" does not match p1"]);
  });

  test("a provider id the operator's file owns cannot be taken by a library document", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", PROVIDER, { ...POLICY, reservedProviderIds: ["p1"] }), [
      "providers/p1: provider id p1 belongs to the operator's file; a library document may add an id, not take one (plan 14 Q5.1)",
    ]);
  });

  test("an anthropic provider is refused with the message kept from before the protocol existed", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, protocol: "anthropic" }, POLICY), ["provider p1: unsupported protocol anthropic"]);
  });
});

describe("library agents and skills: the rules and their messages", () => {
  test("a native agent that names a key the schema does not take is refused for that key", () => {
    const problems = validateLibraryDocument("agents", "a1", { description: "d", role: "writer", adapter: "cli-oneshot", argv: ["x"], parser: "codex-jsonl", zzz: 1 });
    assert.ok(problems.includes("agents/a1: zzz is not allowed in a native library agent (plan 15 IC1)"), JSON.stringify(problems));
  });

  test("an agent that extends a profile may not set the id again, and may not set the injection provider", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a1", { id: "a1", extends: "codex-writer", model: "m", injectProvider: "p1" }), [
      "agents/a1: injectProvider is not allowed in an agent that extends a profile (plan 15 IC1)",
    ]);
  });

  test("a skill over the size limit is named with the limit, and a small one has no problem", () => {
    assert.deepEqual(validateLibraryDocument("skills", "s1", { content: "x".repeat(200000), name: "s1", description: "d" }), [
      "skills/s1: content is larger than 65536 bytes",
    ]);
    assert.deepEqual(validateLibraryDocument("skills", "s1", { content: "hello", name: "s1", description: "d" }), []);
  });
});

describe("the rules that depend on the policy, the URL and the boundaries", () => {
  test("with no policy given, the operator's allowlist is empty and every key name is refused", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", PROVIDER), [
      "providers/p1: apiKeyEnv OPENAI_KEY is not in providerKeyEnv (the operator's allowlist in synapser.config.json)",
    ]);
  });

  test("a malformed address is left to the provider validator, which names it once", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, baseUrl: "http://[" }, POLICY), [
      "provider p1: baseUrl must be https (or loopback for tests)",
    ]);
  });

  test("a key name that is not text is refused as a shape", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p1", { ...PROVIDER, apiKeyEnv: [123] }, POLICY), [
      "provider p1: apiKeyEnv must contain environment variable names",
    ]);
  });

  test("an agent that extends a built-in is checked against that built-in's provider, model by model", () => {
    const extendsProfile = (model: string) => validateLibraryDocument("agents", "a9", { extends: "nemotron-worker", model }, libraryPolicy());
    assert.deepEqual(extendsProfile("not-declared"), ["agents/a9: model not-declared is not declared by provider tokenfactory"]);
    assert.deepEqual(extendsProfile("nvidia/nemotron-3-super-120b-a12b"), []);
  });

  test("a skill of exactly the limit is accepted, and one byte more is refused", () => {
    const skill = (n: number) => ({ content: "x".repeat(n), name: "s1", description: "d" });
    assert.deepEqual(validateLibraryDocument("skills", "s1", skill(65536)), []);
    assert.deepEqual(validateLibraryDocument("skills", "s1", skill(65537)), ["skills/s1: content is larger than 65536 bytes"]);
  });
});

describe("the provider of a library agent: its own, or the one it extends", () => {
  const native = { description: "d", role: "writer", adapter: "native", tags: [], timeoutMs: 1000 };
  test("a native agent's model is checked against the provider it names", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { ...native, provider: "tokenfactory", model: "nope" }, libraryPolicy()), [
      "agents/a9: model nope is not declared by provider tokenfactory",
    ]);
    assert.deepEqual(validateLibraryDocument("agents", "a9", { ...native, provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b" }, libraryPolicy()), []);
  });

  test("a native agent names a provider the operator's file and the library do not define: refused by name", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { ...native, provider: "zz", model: "m" }, libraryPolicy()), [
      "agents/a9: provider zz is defined neither by the operator's file nor by the library",
    ]);
  });

  test("a native agent must name its provider", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { ...native, model: "m" }, libraryPolicy()), ["agents/a9: provider is required for a native library agent"]);
  });

  test("an agent that extends a built-in and sets a provider of its own is checked against the provider it sets", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { extends: "nemotron-worker", provider: "tokenfactory", model: "nope" }, libraryPolicy()), [
      "agents/a9: model nope is not declared by provider tokenfactory",
    ]);
  });
});

describe("a document's own provider wins over the one it extends", () => {
  const OTHER = { protocol: "openai-compatible", baseUrl: "https://other.example/v1/", apiKeyEnv: [], models: [{ id: "other-model" }] };
  const withOther = () => libraryPolicyOf({ providers: defaultModelConfig().providers, providerKeyEnv: [], profiles: [] }, { other: OTHER });

  test("a model declared by the document's own provider is accepted, even when the base's provider lacks it", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { extends: "nemotron-worker", provider: "other", model: "other-model" }, withOther()), []);
  });

  test("a model the document's own provider lacks is named against that provider, not the base's", () => {
    assert.deepEqual(validateLibraryDocument("agents", "a9", { extends: "nemotron-worker", provider: "other", model: "nvidia/nemotron-3-super-120b-a12b" }, withOther()), [
      "agents/a9: model nvidia/nemotron-3-super-120b-a12b is not declared by provider other",
    ]);
  });
});

describe("which provider a library agent runs on (the server lists its dependencies by this)", () => {
  const OTHER = { protocol: "openai-compatible", baseUrl: "https://other.example/v1/", apiKeyEnv: [], models: [{ id: "other-model" }] };
  const policy = libraryPolicyOf({ providers: defaultModelConfig().providers, providerKeyEnv: [], profiles: [] }, { other: OTHER });

  test("its own provider, when it names one", () => {
    assert.equal(providerOfAgent({ extends: "nemotron-worker", provider: "other" }, policy), "other");
  });

  test("the provider of the profile it extends, when it names none", () => {
    assert.equal(providerOfAgent({ extends: "nemotron-worker" }, policy), "tokenfactory");
    assert.equal(providerOfAgent({ extends: "nemotron-worker", provider: 7 }, policy), "tokenfactory", "a provider that is not text is not a provider");
  });

  test("nothing, when it names neither, or extends a profile that is not known", () => {
    assert.equal(providerOfAgent({ model: "m" }, policy), undefined);
    assert.equal(providerOfAgent({ extends: "no-such-profile" }, policy), undefined);
  });
});
