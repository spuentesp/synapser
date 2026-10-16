import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import type { ProviderConfig } from "../../src/model/config.ts";
import { type OperatorFile, LibraryRunError, resolveLibrary, runLibrary } from "../../src/library/resolve.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import type { FrozenLibrary } from "../../src/library/store.ts";
import type { EngineRun } from "../../src/workflow/manager.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";

// Plan 14 Q5.1: a run reads its snapshot under the operator's file as it stands. What the file owns cannot be taken,
// a key outside the file's allowlist refuses the run at start, and a library agent is what resolveAgent says it is.

const FILE_PROVIDER: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://files.example/v1/", apiKeyEnv: ["FILE_KEY"], models: [{ id: "file-model" }] };
const LIB_PROVIDER = { protocol: "openai-compatible", baseUrl: "https://library.example/v1/", apiKeyEnv: ["LIB_KEY"], models: [{ id: "lib-model" }] };

const fileNative: AgentProfile = { id: "file-native", description: "file", role: "writer", adapter: "native", provider: "file-provider", model: "file-model", argv: [], parser: "plain", timeoutMs: 300_000, tags: [], enabled: true };
const filePooled: AgentProfile = { ...fileNative, id: "file-pooled", pool: "p1" };
const fileOff: AgentProfile = { ...fileNative, id: "file-off", enabled: false };

const file: OperatorFile = { providers: { "file-provider": FILE_PROVIDER }, profiles: [fileNative, filePooled, fileOff], providerKeyEnv: ["LIB_KEY"] };

type Doc = { kind: "providers" | "agents" | "skills"; id: string; document: Record<string, unknown> };
function snapshot(docs: Doc[]): FrozenLibrary {
  return {
    entries: docs.map((d) => ({ kind: d.kind, id: d.id, digest: "sha256:0" as FrozenLibrary["entries"][number]["digest"] })),
    get: (kind, id) => docs.find((d) => d.kind === kind && d.id === id)?.document ?? null,
  };
}

const NATIVE = { adapter: "native", description: "d", role: "writer", tags: [], timeoutMs: 120_000 };

describe("the library a run reads (plan 14 Q5.1)", () => {
  test("without a snapshot the run sees the operator's file only", () => {
    const view = resolveLibrary(file, undefined);
    assert.deepEqual(view.profiles, file.profiles);
    assert.deepEqual(view.providers, file.providers);
    assert.deepEqual(view.problems, []);
  });

  test("a library provider and a native agent of its own are part of the run", () => {
    const view = runLibrary(file, snapshot([
      { kind: "providers", id: "lib-provider", document: LIB_PROVIDER },
      { kind: "agents", id: "lib-agent", document: { ...NATIVE, provider: "lib-provider", model: "lib-model" } },
    ]));
    assert.ok(view.providers["lib-provider"]);
    const agent = view.profiles.find((p) => p.id === "lib-agent");
    assert.equal(agent?.provider, "lib-provider");
    assert.equal(agent?.model, "lib-model");
    assert.equal(view.profiles.length, file.profiles.length + 1);
  });

  test("a library agent extending a file profile takes the base and its own overrides; a base the file disables stays off", () => {
    const view = runLibrary(file, snapshot([
      { kind: "agents", id: "lib-tuned", document: { extends: "file-native", description: "tuned", temperature: 0.3 } },
      { kind: "agents", id: "lib-off", document: { extends: "file-off" } },
    ]));
    const tuned = view.profiles.find((p) => p.id === "lib-tuned");
    assert.equal(tuned?.provider, "file-provider");
    assert.equal(tuned?.description, "tuned");
    assert.equal(tuned?.temperature, 0.3);
    assert.equal(tuned?.enabled, true);
    assert.equal(view.profiles.find((p) => p.id === "lib-off")?.enabled, false);
  });

  test("a snapshot whose provider id the operator's file owns refuses the run, with the reason", () => {
    assert.throws(
      () => runLibrary(file, snapshot([{ kind: "providers", id: "file-provider", document: LIB_PROVIDER }])),
      (e: unknown) => e instanceof LibraryRunError && e.problems.some((p) => /belongs to the operator's file/.test(p)),
    );
  });

  test("a snapshot naming a key the operator's file does not allow refuses the run at start, naming the key (plan 15 IC2)", () => {
    const strict: OperatorFile = { ...file, providerKeyEnv: [] };
    assert.throws(
      () => runLibrary(strict, snapshot([{ kind: "providers", id: "lib-provider", document: LIB_PROVIDER }])),
      (e: unknown) => e instanceof LibraryRunError && e.message.includes("apiKeyEnv LIB_KEY is not in providerKeyEnv"),
    );
  });

  test("a library agent cannot take a built-in id, even one the file does not enable", () => {
    assert.throws(
      () => runLibrary(file, snapshot([{ kind: "agents", id: "kimi-writer", document: { extends: "file-native" } }])),
      /is a built-in or file profile/,
    );
  });

  test("a library agent cannot extend a profile the operator's file pools", () => {
    assert.throws(
      () => runLibrary(file, snapshot([{ kind: "agents", id: "lib-pooled", document: { extends: "file-pooled" } }])),
      /does not join a pool/,
    );
  });

  test("a native agent names a provider that exists, and that provider must declare its model", () => {
    const problemsOf = (document: Record<string, unknown>) => resolveLibrary(file, snapshot([{ kind: "agents", id: "lib-x", document }])).problems.join("\n");
    assert.match(problemsOf({ ...NATIVE, provider: "nowhere", model: "lib-model" }), /provider nowhere is defined neither by the operator's file nor by the library/);
    assert.match(problemsOf({ ...NATIVE, provider: "file-provider", model: "lib-model" }), /model lib-model is not declared by provider file-provider/);
  });

  test("a view that is not strict leaves out the document that fails and keeps the rest", () => {
    const view = resolveLibrary(file, snapshot([
      { kind: "agents", id: "ok-agent", document: { extends: "file-native" } },
      { kind: "agents", id: "bad-agent", document: { extends: "nope" } },
    ]));
    assert.ok(view.profiles.some((p) => p.id === "ok-agent"));
    assert.ok(!view.profiles.some((p) => p.id === "bad-agent"));
    assert.equal(view.problems.length, 1);
  });
});

describe("library skills in a run (plan 14 Q5.4)", () => {
  const STYLE = "Write short sentences, and no jargon.";
  const withSkill = (agentSkills: Record<string, string[]>): OperatorFile => ({ ...file, agentSkills });
  const agentDoc = { extends: "file-native", description: "tuned", temperature: 0.3 };
  const skillDoc = (content: string) => ({ id: "style", name: "style", description: "house style", content });

  test("a skill the operator's file assigns to an agent enters its run, with the digest of its bytes (L1)", () => {
    const view = runLibrary(withSkill({ "lib-tuned": ["style"] }), snapshot([
      { kind: "agents", id: "lib-tuned", document: agentDoc },
      { kind: "skills", id: "style", document: skillDoc(STYLE) },
    ]));
    assert.deepEqual(view.skillsFor.get("lib-tuned"), [
      { id: "style", digest: sha256Bytes(Buffer.from(STYLE, "utf8")), content: STYLE, selectionReason: "operator-default", source: "library" },
    ]);
  });

  test("an agent the file does not assign a skill to receives none", () => {
    const view = runLibrary(withSkill({}), snapshot([{ kind: "agents", id: "lib-tuned", document: agentDoc }]));
    assert.equal(view.skillsFor.get("lib-tuned"), undefined);
  });

  test("the operator cannot authorize skill injection for an adapter without a skill mechanism", () => {
    const cli: AgentProfile = { ...fileNative, id: "plain-cli", adapter: "cli-oneshot", argv: ["tool", "{prompt}"], parser: "plain" };
    const operator: OperatorFile = { ...file, profiles: [cli], agentSkills: { "plain-cli": ["style"] } };
    assert.throws(
      () => runLibrary(operator, snapshot([{ kind: "skills", id: "style", document: skillDoc(STYLE) }])),
      (e: unknown) => e instanceof LibraryRunError && e.message.includes("adapter cli-oneshot does not support skill injection"),
    );
  });

  test("a skill the file names but the library does not hold refuses the run, naming the agent and the skill", () => {
    assert.throws(
      () => runLibrary(withSkill({ "lib-tuned": ["style"] }), snapshot([{ kind: "agents", id: "lib-tuned", document: agentDoc }])),
      (e: unknown) => e instanceof LibraryRunError && e.message.includes("agentSkills.lib-tuned: skill style is not in this run's library"),
    );
  });

  test("a skill over the size limit refuses the run (64 KiB, as the library rules say)", () => {
    assert.throws(
      () => runLibrary(withSkill({ "lib-tuned": ["style"] }), snapshot([
        { kind: "agents", id: "lib-tuned", document: agentDoc },
        { kind: "skills", id: "style", document: skillDoc("x".repeat(64 * 1024 + 1)) },
      ])),
      /content is larger than/,
    );
  });

  test("more than five skills for one agent is refused (decision D6)", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    assert.throws(
      () => runLibrary(withSkill({ "lib-tuned": ids }), snapshot([{ kind: "agents", id: "lib-tuned", document: agentDoc }])),
      /at most 5 skills per agent/,
    );
  });

  test("an agent the file names must be a profile of the operator's file or of the library", () => {
    assert.throws(
      () => runLibrary(withSkill({ ghost: ["style"] }), snapshot([{ kind: "skills", id: "style", document: skillDoc(STYLE) }])),
      /agentSkills: ghost is not a profile/,
    );
  });
});

describe("the engine refuses a run whose library does not hold (plan 14 Q5.1)", () => {
  test("the run ends FAILED with the reason, before it takes the workspace lock", async () => {
    const engine = new ProductionEngine({
      workspaceRoot: "/nonexistent-synapser-workspace",
      stateDir: "/nonexistent-synapser-state",
      commands: [],
      profiles: [fileNative],
      providers: { "file-provider": FILE_PROVIDER },
      models: () => {
        throw new Error("no model is expected: the run must stop before planning");
      },
    });
    const result = await engine.run({ library: snapshot([{ kind: "providers", id: "file-provider", document: LIB_PROVIDER }]) } as unknown as EngineRun);
    assert.equal(result.status, "FAILED");
    assert.match((result as { reason?: string | null }).reason ?? "", /belongs to the operator's file/);
  });

  test("a run whose reviews name an agent its library does not hold ends FAILED before it starts (plan 14 Q5.2)", async () => {
    const engine = new ProductionEngine({
      workspaceRoot: "/nonexistent-synapser-workspace",
      stateDir: "/nonexistent-synapser-state",
      commands: [],
      profiles: [fileNative],
      providers: { "file-provider": FILE_PROVIDER },
      models: () => {
        throw new Error("no model is expected: the run must stop before planning");
      },
    });
    const workflow = { conditions: [{ id: "rv", statement: "idiomatic", required: false, checker: { kind: "review", profile: "ghost", rubric: "judge" } }] };
    const result = await engine.run({ library: snapshot([]), workflow: () => workflow } as unknown as EngineRun);
    assert.equal(result.status, "FAILED");
    assert.match((result as { reason?: string | null }).reason ?? "", /does not hold the agents its reviews name: ghost/);
  });
});
