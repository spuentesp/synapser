import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

// P15 IC2: the names a library provider may use as its key come only from the operator's file, and default to none.

function load(raw: object) {
  const root = mkdtempSync(join(tmpdir(), "allow-"));
  const path = join(root, "c.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "s"), research: false, ...raw }));
  return loadConfig({ path });
}

describe("the key allowlist of library providers (P15 IC2)", () => {
  test("by default no name is allowed", () => {
    assert.deepEqual(load({}).providerKeyEnv, []);
  });

  test("the operator's list is kept, without duplicates", () => {
    assert.deepEqual(load({ providerKeyEnv: ["MY_PROVIDER_KEY", "MY_PROVIDER_KEY", "OTHER_KEY"] }).providerKeyEnv, ["MY_PROVIDER_KEY", "OTHER_KEY"]);
  });

  test("a name that is not an environment variable name refuses the whole file", () => {
    assert.throws(() => load({ providerKeyEnv: ["lower-case", "OK_KEY"] }), (e: unknown) => e instanceof ConfigError && /providerKeyEnv must be a list of environment variable names/.test(e.errors.join("\n")));
  });
});
