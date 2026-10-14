import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

// Plan 15 P15.7 (decision D7): the trust mode is configurable; operator is the default, adversarial is the other mode.

function load(raw: object) {
  const root = mkdtempSync(join(tmpdir(), "trust-mode-"));
  const path = join(root, "c.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "s"), research: false, ...raw }));
  return loadConfig({ path });
}

describe("the trust mode of the operator's file (plan 15 D7)", () => {
  test("by default the operator and its processes are trusted", () => {
    assert.equal(load({}).trustMode, "operator");
  });

  test("the file can choose the adversarial mode", () => {
    assert.equal(load({ trustMode: "adversarial" }).trustMode, "adversarial");
  });

  test("any other value refuses the whole file", () => {
    assert.throws(() => load({ trustMode: "paranoid" }), (e: unknown) => e instanceof ConfigError && /trustMode must be/.test(e.errors.join("\n")));
  });
});
