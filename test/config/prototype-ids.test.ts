import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

// Provider ids are looked up as OWN keys only. An id that names an Object.prototype member is a configuration
// problem in the whole-file list (K2), never a TypeError from inside the loader.

function load(raw: object): ConfigError | null {
  const root = mkdtempSync(join(tmpdir(), "proto-"));
  const path = join(root, "c.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "s"), research: false, ...raw }));
  try {
    loadConfig({ path });
    return null;
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
}

describe("provider ids are own keys only (K2)", () => {
  // "constructor" is a valid slug, so it reaches the lookup; the others are not slugs and fail the profile rules first
  const cases: [string, RegExp][] = [
    ["constructor", /agent "native-bad" references unknown provider "constructor"/],
    ["toString", /provider must be a lowercase slug/],
    ["__proto__", /provider must be a lowercase slug/],
  ];
  for (const [id, expected] of cases) {
    test(`a native agent naming provider "${id}" is refused with the whole-file error list`, () => {
      const err = load({ agents: [{ id: "native-bad", adapter: "native", provider: id, model: "m1", argv: [], parser: "plain" }] });
      assert.ok(err, "the file must be refused");
      assert.match(err.errors.join("\n"), expected);
    });
  }

  test('a system role naming provider "constructor" is refused with the whole-file error list', () => {
    const err = load({ roles: { chat: { provider: "constructor", model: "m1" } } });
    assert.ok(err, "the file must be refused");
    assert.match(err.errors.join("\n"), /roles\.chat: unknown provider constructor/);
  });
});
