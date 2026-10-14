import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { doctor, type Probe } from "../../src/cli/doctor.ts";
import { loadConfig } from "../../src/config/load.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore, readLibrary } from "../../src/library/store.ts";

// Plan 14 Q2.7: doctor and config show read the library next to the file. Reading writes nothing: no journal is
// created and no projection is materialised. Provider keys are informational, because no run uses a library
// provider yet; a document that no longer passes its rules is a real failure.

const PROVIDER = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["READ_TEST_KEY"], models: [{ id: "m1", usdPer1MIn: 0.5, usdPer1MOut: 1.5 }] };
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const run = promisify(execFile);

function stateWith(put: (lib: LibraryStore) => void): string {
  const state = mkdtempSync(join(tmpdir(), "read-state-"));
  const sj = Journal.open(state, "_server");
  put(new LibraryStore(state, sj));
  sj.close();
  return state;
}

function configFor(state: string, extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "read-cfg-"));
  const path = join(root, "synapser.config.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: state, research: false, ...extra }));
  return path;
}

const probe: Probe = {
  which: async (c) => (["git", "python3", "zoanthrope"].includes(c) ? `/usr/bin/${c}` : null),
  version: async () => "1.0",
  env: (n) => n === "NEBIUS_TOKEN",
  nodeVersion: () => "24.2.0",
  exists: () => true,
  writable: () => true,
};

describe("the library as doctor and config show read it (plan 14 Q2.7)", () => {
  test("a state dir with no library reads as empty and gains no journal", () => {
    const state = mkdtempSync(join(tmpdir(), "read-empty-"));
    try {
      assert.deepEqual(readLibrary(state), []);
      assert.equal(existsSync(join(state, "_server")), false, "no server journal was created");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("reading never materialises the projection: a missing library folder stays missing", () => {
    const state = stateWith((lib) => lib.put("providers", "read-local", PROVIDER, "test:operator"));
    try {
      rmSync(join(state, "library"), { recursive: true, force: true });
      const entries = readLibrary(state);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.kind, "providers");
      assert.equal(existsSync(join(state, "library")), false, "the projection was not rebuilt by reading");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a read-only handle refuses every write", () => {
    const state = stateWith((lib) => lib.put("providers", "read-local", PROVIDER, "test:operator"));
    const sj = Journal.open(state, "_server");
    try {
      const reader = new LibraryStore(state, sj, { readOnly: true });
      assert.throws(() => reader.put("providers", "other", PROVIDER, "test:operator"), /read-only/);
      assert.throws(() => reader.remove("providers", "read-local", "test:operator"), /read-only/);
      assert.equal(reader.get("providers", "read-local")?.kind, "providers", "reads still work");
    } finally {
      sj.close();
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("doctor shows the library, reports a provider key as information, and stays ok", async () => {
    const state = stateWith((lib) => lib.put("providers", "read-local", PROVIDER, "test:operator"));
    try {
      // the operator's file allows the key name (plan 15 IC2); without that, the document itself fails (next test)
      const cfg = loadConfig({ path: configFor(state, { providerKeyEnv: ["READ_TEST_KEY"] }) });
      const rep = await doctor(cfg, probe);
      const check = (name: string) => rep.checks.find((c) => c.name === name)!;
      assert.equal(check("library").ok, true);
      assert.equal(check("library").detail, "providers 1 · agents 0 · skills 0 · templates 0");
      assert.equal(check("library provider key (read-local)").ok, false);
      assert.match(check("library provider key (read-local)").detail, /none of READ_TEST_KEY is set/);
      assert.equal(rep.ok, true, "a missing library provider key is information, not a failure");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("doctor fails a library provider whose key name the operator's file does not allow (plan 15 IC2)", async () => {
    const state = stateWith((lib) => lib.put("providers", "read-local", PROVIDER, "test:operator"));
    try {
      const rep = await doctor(loadConfig({ path: configFor(state) }), probe);
      const check = rep.checks.find((c) => c.name === "library providers/read-local")!;
      assert.equal(check.ok, false);
      assert.match(check.detail, /apiKeyEnv READ_TEST_KEY is not in providerKeyEnv/);
      assert.equal(rep.ok, false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("doctor fails a library document that no longer passes its rules, and says which rule", async () => {
    const broken = { ...PROVIDER, baseUrl: "http://remote.example/v1/" };
    const state = stateWith((lib) => lib.put("providers", "broken", broken, "test:operator"));
    try {
      const rep = await doctor(loadConfig({ path: configFor(state) }), probe);
      const check = rep.checks.find((c) => c.name === "library providers/broken")!;
      assert.equal(check.ok, false);
      assert.match(check.detail, /must be https/);
      assert.equal(rep.ok, false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("config show lists the library's index next to the file config, without its documents", async () => {
    const state = stateWith((lib) => lib.put("providers", "read-local", PROVIDER, "test:operator"));
    try {
      const { stdout } = await run(process.execPath, [MAIN, "--config", configFor(state), "config", "show"]);
      const shown = JSON.parse(stdout) as { library: { kind: string; id: string; digest: string; document?: unknown }[]; workspace: string };
      assert.equal(shown.library.length, 1);
      assert.deepEqual([shown.library[0]!.kind, shown.library[0]!.id], ["providers", "read-local"]);
      assert.match(shown.library[0]!.digest, /^sha256:/);
      assert.equal(shown.library[0]!.document, undefined, "the index carries no documents");
      assert.equal(typeof shown.workspace, "string", "the file config is still there");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
