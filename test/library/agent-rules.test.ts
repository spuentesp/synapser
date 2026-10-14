import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AgentProfile, BUILTIN_PROFILES } from "../../src/agents/profile.ts";
import { type LibraryPolicy, libraryPolicyOf, validateLibraryDocument } from "../../src/library/validate.ts";

// Plan 15 IC1. A library agent either extends a profile (case a) and sets some of its fields, or is a native agent of its
// own (case b). The fields that run commands or widen access stay in the operator's file. Each refused field and each
// accepted field has its own test. The falsification of plan 15 section 7 copies argv from the library: it must fail (a).

const fileNative: AgentProfile = {
  id: "file-native",
  description: "a native profile of the operator's file",
  role: "writer",
  adapter: "native",
  provider: "file-provider",
  model: "m1",
  argv: [],
  parser: "plain",
  timeoutMs: 300_000,
  tags: [],
  enabled: true,
};

const builtin = (id: string): AgentProfile => {
  const found = BUILTIN_PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`no built-in profile ${id}`);
  return found;
};

const PROVIDER = { protocol: "openai-compatible" as const, baseUrl: "https://models.example/v1/", apiKeyEnv: ["LIB_KEY"], models: [{ id: "m1" }, { id: "m2" }] };

const policy: LibraryPolicy = {
  providerKeyEnv: [],
  bases: [
    { profile: builtin("codex-writer"), enabledByFile: true },
    { profile: builtin("claude-sonnet-writer"), enabledByFile: false },
    { profile: fileNative, enabledByFile: true },
  ],
  providers: { "file-provider": PROVIDER, "lib-provider": PROVIDER },
  reservedProviderIds: ["file-provider"],
};

const check = (id: string, document: unknown) => validateLibraryDocument("agents", id, document, policy);

// a value of each field that only the operator's file may set (plan 15 IC1)
const FILE_ONLY: Record<string, unknown> = {
  argv: ["codex", "exec", "{prompt}"],
  env: { PATH: "/tmp/elsewhere" },
  homeOverlay: [".ssh"],
  permissions: { mode: "bypassPermissions" },
  maxBudgetUsd: 5,
  parser: "plain",
  pool: "p1",
  steerable: "turn",
  disabledReason: "not for library documents",
};

const NATIVE_VALID = { adapter: "native", description: "a native agent of the library", role: "writer", tags: [], timeoutMs: 120_000, provider: "lib-provider", model: "m2" };

describe("plan 15 IC1, case (a): an agent that extends a profile", () => {
  for (const [field, value] of Object.entries(FILE_ONLY)) {
    test(`refuses ${field}, which only the operator's file may set`, () => {
      assert.deepEqual(check("w1", { extends: "codex-writer", [field]: value }), [`agents/w1: ${field} is set by the operator's file, never by a library agent (plan 15 IC1)`]);
    });
  }

  for (const [field, value] of Object.entries({ adapter: "native", role: "advisor", nativeRole: "repair" })) {
    test(`refuses ${field}: the base decides it`, () => {
      assert.deepEqual(check("w1", { extends: "codex-writer", [field]: value }), [`agents/w1: ${field} is not allowed in an agent that extends a profile (plan 15 IC1)`]);
    });
  }

  const onCommandLineBase: Record<string, unknown> = { description: "a shorter note", tags: ["review"], tier: "cheap", timeoutMs: 60_000, enabled: false, model: "gpt-x" };
  for (const [field, value] of Object.entries(onCommandLineBase)) {
    test(`accepts ${field} over a command-line base`, () => {
      assert.deepEqual(check("w1", { extends: "codex-writer", [field]: value }), []);
    });
  }

  const onNativeBase: Record<string, unknown> = { provider: "lib-provider", temperature: 0.2 };
  for (const [field, value] of Object.entries(onNativeBase)) {
    test(`accepts ${field} over a native base`, () => {
      assert.deepEqual(check("n1", { extends: "file-native", [field]: value }), []);
    });
  }

  test("timeoutMs stops at one hour", () => {
    assert.deepEqual(check("w1", { extends: "codex-writer", timeoutMs: 3_600_000 }), []);
    assert.match(check("w1", { extends: "codex-writer", timeoutMs: 3_600_001 }).join("\n"), /timeoutMs must be a positive number/);
  });

  test("temperature stays between 0 and 2", () => {
    assert.match(check("n1", { extends: "file-native", temperature: 2.5 }).join("\n"), /temperature must be a number from 0 to 2/);
  });

  test("a provider over a command-line base is refused by the profile rules, on the merged profile", () => {
    assert.deepEqual(check("w1", { extends: "codex-writer", provider: "lib-provider", model: "m1" }), ["agents/w1: only a native agent may reference a provider"]);
  });

  test("enabled true is refused when the operator's file does not enable the base", () => {
    assert.deepEqual(check("w1", { extends: "claude-sonnet-writer", enabled: true }), [`agents/w1: enabled true needs the operator's file to enable claude-sonnet-writer (plan 15 IC1)`]);
  });

  test("enabled true is accepted when the operator's file enables the base", () => {
    assert.deepEqual(check("w1", { extends: "codex-writer", enabled: true }), []);
  });

  test("a document that says nothing about enabled passes; the run-time resolver keeps a disabled base off (Q5.1)", () => {
    assert.deepEqual(check("w1", { extends: "claude-sonnet-writer" }), []);
  });

  test("a base that is neither built-in nor in the operator's file is refused", () => {
    assert.deepEqual(check("w1", { extends: "nope" }), ["agents/w1: extends nope, which is neither a built-in profile nor one of the operator's file"]);
  });

  test("extends must be an id", () => {
    assert.match(check("w1", { extends: 5 }).join("\n"), /extends must be the id of a profile/);
  });
});

describe("plan 15 IC1, case (b): a native agent of its own", () => {
  test("a complete native agent is accepted", () => {
    assert.deepEqual(check("n2", { ...NATIVE_VALID, role: "advisor", enabled: true, tier: "advanced", temperature: 0.1, nativeRole: "repair" }), []);
  });

  for (const [field, value] of Object.entries(FILE_ONLY)) {
    test(`refuses ${field}, which only the operator's file may set`, () => {
      assert.deepEqual(check("n2", { ...NATIVE_VALID, [field]: value }), [`agents/n2: ${field} is set by the operator's file, never by a library agent (plan 15 IC1)`]);
    });
  }

  for (const field of ["adapter", "role", "description", "tags", "timeoutMs", "model", "provider"]) {
    test(`needs ${field}`, () => {
      const rest: Record<string, unknown> = { ...NATIVE_VALID };
      delete rest[field];
      assert.match(check("n2", rest).join("\n"), new RegExp(`agents/n2: ${field} is required for a native library agent`));
    });
  }

  test("adapter must be native", () => {
    assert.match(check("n2", { ...NATIVE_VALID, adapter: "claude-code" }).join("\n"), /adapter must be "native"/);
  });

  test("role must be writer or advisor", () => {
    assert.match(check("n2", { ...NATIVE_VALID, role: "boss" }).join("\n"), /role must be "writer" or "advisor"/);
  });

  test("nativeRole must be worker or repair", () => {
    assert.match(check("n2", { ...NATIVE_VALID, nativeRole: "judge" }).join("\n"), /nativeRole must be "worker" or "repair"/);
  });
});

describe("libraryPolicyOf: what the operator's file makes a base", () => {
  test("a base is enabled by the file only where the file's list enables it", () => {
    const p = libraryPolicyOf({ providers: {}, providerKeyEnv: ["K"], profiles: [builtin("codex-writer"), { ...builtin("claude-sonnet-writer"), enabled: false }] });
    const enabled = (id: string) => p.bases.find((b) => b.profile.id === id)?.enabledByFile;
    assert.equal(enabled("codex-writer"), true);
    assert.equal(enabled("claude-sonnet-writer"), false, "listed but disabled by the file");
    assert.equal(enabled("kimi-writer"), false, "a built-in the file does not list is off");
    assert.deepEqual(p.providerKeyEnv, ["K"]);
  });
});

// P16.3, found by a probe at the trust boundary. JSON.parse makes an own "__proto__" key, which an object literal cannot,
// and a provider named "constructor" was read from Object.prototype, so the validator threw a TypeError where it should
// refuse. The documents here come from JSON, as the API's do. Before the fix the provider cases threw instead.
describe("P16.3: prototype names from JSON are refused, never read as the document's own rules", () => {
  const policy = libraryPolicyOf({ providers: { "file-p": PROVIDER }, providerKeyEnv: ["LIB_KEY"], profiles: [builtin("nemotron-worker")] });
  const NATIVE = `"adapter":"native","role":"writer","description":"d","tags":[],"timeoutMs":1000,"model":"m1","provider":"file-p"`;
  const EXTENDING = `"extends":"nemotron-worker","description":"d","provider":"file-p","model":"m1"`;
  const check = (id: string, json: string) => validateLibraryDocument("agents", id, JSON.parse(json), policy);

  test("an own __proto__, constructor or toString key is refused, in both variants", () => {
    for (const [extra, key] of [[`"__proto__":{"argv":["sh"]}`, "__proto__"], [`"constructor":1`, "constructor"], [`"toString":"x"`, "toString"]] as const) {
      assert.deepEqual(check("lib-n", `{${NATIVE},${extra}}`), [`agents/lib-n: ${key} is not allowed in a native library agent (plan 15 IC1)`]);
      assert.deepEqual(check("lib-e", `{${EXTENDING},${extra}}`), [`agents/lib-e: ${key} is not allowed in an agent that extends a profile (plan 15 IC1)`]);
    }
  });

  test("a base named like a prototype is an unknown base, not a built-in profile", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      assert.deepEqual(check("lib-e", `{"extends":"${name}","description":"d"}`), [`agents/lib-e: extends ${name}, which is neither a built-in profile nor one of the operator's file`]);
    }
  });

  test("a provider named like a prototype is undeclared, and is not read from Object.prototype", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      // validateProfile reports a name that is not a lowercase slug first; the provider check follows
      const undeclared = `provider ${name} is defined neither by the operator's file nor by the library`;
      const slug = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? [] : ["provider must be a lowercase slug"];
      assert.deepEqual(check("lib-n", `{${NATIVE.replace(`"provider":"file-p"`, `"provider":"${name}"`)}}`), [...slug.map((s) => `agents/lib-n: ${s}`), `agents/lib-n: ${undeclared}`]);
      assert.deepEqual(check("lib-e", `{${EXTENDING.replace(`"provider":"file-p"`, `"provider":"${name}"`)}}`), [...slug.map((s) => `agents/lib-e: ${s}`), `agents/lib-e: ${undeclared}`]);
    }
  });

  test("a model named like a prototype is not declared by the provider", () => {
    assert.deepEqual(check("lib-n", `{${NATIVE.replace(`"model":"m1"`, `"model":"constructor"`)}}`), ["agents/lib-n: model constructor is not declared by provider file-p"]);
  });
});
