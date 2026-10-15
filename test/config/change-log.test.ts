import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { defaultModelConfig, type ProviderConfig, type RoleConfig } from "../../src/model/config.ts";
import type { Role } from "../../src/model/types.ts";

// Plan 17 P17.8 step 4: every change, applied or refused, is recorded with digests and no key value.
const HOT: ProviderConfig = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

describe("plan 17 P17.8 step 4: the configuration change log", () => {
  let dir: string;
  let live: LiveConfig;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfg-log-"));
    const path = join(dir, "synapser.config.json");
    writeFileSync(path, JSON.stringify({ workspace: dir }));
    const d = defaultModelConfig();
    live = { configPath: path, stateDir: dir, providers: { ...d.providers }, roles: { ...d.roles } as Record<Role, RoleConfig> };
    log = join(dir, "config-changes.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lines = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  test("an applied change is recorded with the table digest before and after", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    const [entry] = lines();
    assert.equal(entry!["outcome"], "applied");
    assert.equal(entry!["kind"], "providers");
    assert.equal(entry!["id"], "hot");
    assert.notEqual(entry!["digestBefore"], entry!["digestAfter"]);
    assert.deepEqual(entry!["problems"], []);
  });

  test("a refused change is recorded with its problems and the table is unchanged", () => {
    const before = JSON.stringify(live.providers);
    assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "meta", value: { ...HOT, baseUrl: "http://169.254.169.254/" } }), ConfigWriteError);
    const [entry] = lines();
    assert.equal(entry!["outcome"], "refused");
    assert.match((entry!["problems"] as string[]).join(" "), /metadata/);
    assert.equal(entry!["digestAfter"], null);
    assert.equal(JSON.stringify(live.providers), before);
  });

  test("a key value offered as a variable name never reaches the log", () => {
    const secret = "sk-test-LOGGED-VALUE-0001";
    assert.throws(() => writeLiveConfig(live, { kind: "providers", id: "leak", value: { ...HOT, apiKeyEnv: [secret] } }), ConfigWriteError);
    assert.equal(readFileSync(log, "utf8").includes(secret), false);
  });

  test("entries accumulate in order, one line each", () => {
    writeLiveConfig(live, { kind: "providers", id: "hot", value: HOT });
    assert.throws(() => writeLiveConfig(live, { kind: "roles", id: "not-a-role", value: {} }), ConfigWriteError);
    assert.deepEqual(lines().map((l) => l["outcome"]), ["applied", "refused"]);
  });
});
