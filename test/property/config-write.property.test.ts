import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import fc from "fast-check";
import { ConfigWriteError, type LiveConfig, writeLiveConfig } from "../../src/config/write.ts";
import { defaultModelConfig, type RoleConfig } from "../../src/model/config.ts";
import type { Role } from "../../src/model/types.ts";
import { RUN } from "./support.ts";

// Plan 18 E3 (H3.5): an accepted write reads back as written; a refused write leaves the file byte for byte unchanged.
const slug = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
const validProvider = fc.record({
  id: slug,
  key: fc.stringMatching(/^[A-Z][A-Z0-9_]{2,12}$/),
  model: fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}$/),
});
const badUrl = fc.oneof(fc.constant("http://169.254.169.254/x"), fc.constant("ftp://models.example/v1"), fc.stringMatching(/^[a-z]{1,8}$/));

function fresh(): { dir: string; path: string; live: LiveConfig } {
  const dir = mkdtempSync(join(tmpdir(), "prop-cfg-"));
  const path = join(dir, "synapser.config.json");
  writeFileSync(path, JSON.stringify({ workspace: dir }));
  const d = defaultModelConfig();
  return { dir, path, live: { configPath: path, stateDir: dir, providers: { ...d.providers }, roles: { ...d.roles } as Record<Role, RoleConfig> } };
}

describe("H3.5 configuration writes", () => {
  test("an accepted provider reads back as written, and the file holds names only", () => {
    fc.assert(
      fc.property(validProvider, (p) => {
        const { dir, path, live } = fresh();
        try {
          const value = { protocol: "openai-compatible", baseUrl: `https://${p.id}.example/v1`, apiKeyEnv: [p.key], models: [{ id: p.model }] };
          writeLiveConfig(live, { kind: "providers", id: p.id, value });
          const back = JSON.parse(readFileSync(path, "utf8")).providers[p.id];
          assert.deepEqual(back, value);
          assert.deepEqual(live.providers[p.id], value);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { ...RUN, numRuns: Math.min(RUN.numRuns, 60) },
    );
  });

  test("a refused provider leaves the operator file byte for byte unchanged", () => {
    fc.assert(
      fc.property(validProvider, badUrl, (p, url) => {
        const { dir, path, live } = fresh();
        try {
          const before = readFileSync(path, "utf8");
          assert.throws(
            () => writeLiveConfig(live, { kind: "providers", id: p.id, value: { protocol: "openai-compatible", baseUrl: url, apiKeyEnv: [p.key], models: [{ id: p.model }] } }),
            ConfigWriteError,
          );
          assert.equal(readFileSync(path, "utf8"), before);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { ...RUN, numRuns: Math.min(RUN.numRuns, 60) },
    );
  });
});
