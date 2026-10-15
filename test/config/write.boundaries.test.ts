import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { ConfigWriteError, type LiveConfig, replaceInPlace, writeLiveConfig } from "../../src/config/write.ts";
import type { ProviderConfig } from "../../src/model/config.ts";

// Plan 18 E4 (H4.4): the branches and messages of the configuration writer that mutation testing showed were not pinned.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("replaceInPlace keeps the holder's object and makes it equal to the new content", () => {
  test("keys that are no longer present are removed, and new or changed keys are set", () => {
    const holder: Record<string, number> = { a: 1, b: 2 };
    const same = holder;
    replaceInPlace(holder, { b: 3, c: 4 });
    assert.equal(holder, same, "the same object, so every holder sees the change");
    assert.deepEqual(holder, { b: 3, c: 4 });
  });
});

describe("the change log records the table digests and the problems exactly", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-bnd-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lines = () => readFileSync(join(dir, "state", "config-changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  test("an applied line carries exactly its fields; the next line starts from the previous digest", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    writeLiveConfig(live, { kind: "providers", id: "hot2", value: { ...HOT, baseUrl: "https://hot2.example/v1/" } });
    const [a, b] = lines();
    assert.deepEqual(Object.keys(a!).sort(), ["at", "digestAfter", "digestBefore", "id", "kind", "outcome", "problems"]);
    assert.equal(a!["outcome"], "applied");
    assert.equal(a!["kind"], "providers");
    assert.equal(typeof a!["at"], "string");
    assert.notEqual(a!["digestAfter"], a!["digestBefore"]);
    assert.equal(b!["digestBefore"], a!["digestAfter"], "the second change starts where the first ended");
  });

  test("a refused line has no digestAfter and names the same problems the error carries", () => {
    let thrown: ConfigWriteError | null = null;
    try {
      writeLiveConfig(live, { kind: "providers", id: "meta", value: { ...HOT, baseUrl: "http://169.254.169.254/" } });
    } catch (e) {
      thrown = e as ConfigWriteError;
    }
    assert.ok(thrown);
    const [refused] = lines();
    assert.equal(refused!["outcome"], "refused");
    assert.equal(refused!["digestAfter"], null);
    assert.deepEqual(refused!["problems"], thrown!.errors);
  });
});

describe("the writer's refusals name their cause in exact words", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-msg-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir }));
    const cfg = loadConfig({ path });
    live = { configPath: path, providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const refusal = (fn: () => void): string[] => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ConfigWriteError, String(e));
      return e.errors;
    }
    assert.fail("expected a refusal");
  };

  test("no operator file, an unknown role, an agent that is not an object, and no live agent list", () => {
    assert.deepEqual(refusal(() => writeLiveConfig({ ...live, configPath: null }, { kind: "providers", id: "hot", value: HOT })), ["there is no operator file to write: create synapser.config.json first"]);
    assert.deepEqual(refusal(() => writeLiveConfig(live, { kind: "roles", id: "not-a-role", value: {} })), ["unknown role not-a-role"]);
    assert.deepEqual(refusal(() => writeLiveConfig(live, { kind: "agents", id: "x", value: "nope" })), ["an agent is an object"]);
    assert.deepEqual(refusal(() => writeLiveConfig({ ...live, profiles: undefined }, { kind: "agents", id: "x", value: { extends: "codex-writer" } })), ["agents cannot change: this process holds no live agent list"]);
  });

  test("an agent that names an unknown provider says so, and the file is untouched", () => {
    const before = readFileSync(path, "utf8");
    assert.deepEqual(refusal(() => writeLiveConfig(live, { kind: "agents", id: "bad", value: { extends: "codex-writer", injectProvider: "nope", model: "m" } })), ["agent bad: unknown provider nope"]);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test("a role change is checked against the whole table: its provider must exist", () => {
    const problems = refusal(() => writeLiveConfig(live, { kind: "roles", id: "worker", value: { provider: "missing", model: "m" } }));
    assert.ok(problems.some((p) => /missing/.test(p)), problems.join(" | "));
  });
});

describe("agents: a changed agent replaces its entry, a new one is appended", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-agents-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writing the same agent twice leaves one entry, with the second value", () => {
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model", tier: "advanced" } });
    const agents = JSON.parse(readFileSync(path, "utf8")).agents as { id: string; tier?: string }[];
    assert.equal(agents.filter((a) => a.id === "hot-agent").length, 1);
    assert.equal(agents.find((a) => a.id === "hot-agent")!.tier, "advanced");
    assert.equal(live.profiles!.find((p) => p.id === "hot-agent")!.tier, "advanced");
  });

  test("an agent added after another keeps the first one", () => {
    writeLiveConfig(live, { kind: "agents", id: "one", value: { extends: "codex-writer" } });
    writeLiveConfig(live, { kind: "agents", id: "two", value: { extends: "codex-writer" } });
    const ids = (JSON.parse(readFileSync(path, "utf8")).agents as { id: string }[]).map((a) => a.id);
    assert.deepEqual(ids, ["one", "two"]);
  });
});

describe("the remaining writer gaps (plan 18 E4)", () => {
  let dir: string;
  let path: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-gaps-"));
    path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const cfg = loadConfig({ path });
    live = { configPath: path, stateDir: join(dir, "state"), providers: cfg.providers, roles: cfg.roles, profiles: cfg.profiles };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a refusal's message joins its problems with '; ' and carries each one", () => {
    const err = (() => {
      try {
        writeLiveConfig(live, { kind: "providers", id: "meta", value: { protocol: "openai-compatible", baseUrl: "http://169.254.169.254/", apiKeyEnv: ["x"], models: [] } });
      } catch (e) {
        return e as ConfigWriteError;
      }
      return null;
    })();
    assert.ok(err && err.errors.length >= 2, "the example has at least two problems");
    assert.equal(err.message, err.errors.join("; "));
  });

  test("the operator file and the log are private to their owner (mode 0600)", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "state", "config-changes.jsonl")).mode & 0o777, 0o600);
  });

  test("a corrupt operator file is an error, not a refusal, and it is not written to the log", () => {
    writeFileSync(path, "{ not json");
    assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT }), SyntaxError);
    assert.equal(existsSync(join(dir, "state", "config-changes.jsonl")), false);
  });

  test("a role is accepted only when it is one of the system roles, and a known one is written", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    writeLiveConfig(live, { kind: "roles", id: "worker", value: { provider: "hot", model: "hot-model" } });
    assert.equal(live.roles.worker.provider, "hot");
    assert.throws(() => writeLiveConfig(live, { kind: "roles", id: "boss", value: { provider: "hot", model: "hot-model" } }), /unknown role boss/);
  });

  test("the digest moves when an agent is added, so a change to the agents is always visible in the log", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    writeLiveConfig(live, { kind: "agents", id: "hot-agent", value: { extends: "codex-writer", injectProvider: "hot", model: "hot-model" } });
    const lines = readFileSync(join(dir, "state", "config-changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { digestAfter: string; digestBefore: string });
    assert.notEqual(lines[1]!.digestBefore, lines[1]!.digestAfter);
    assert.equal(lines[1]!.digestBefore, lines[0]!.digestAfter);
  });
});
