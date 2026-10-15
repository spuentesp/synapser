import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { LIBRARY_KINDS, LibraryStore } from "../../src/library/store.ts";

describe("versioned state library", () => {
  let state: string;
  let journal: Journal;
  let library: LibraryStore;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "synapser-library-"));
    journal = Journal.open(state, "_server");
    library = new LibraryStore(state, journal);
  });
  afterEach(() => {
    journal.close();
    rmSync(state, { recursive: true, force: true });
  });

  test("providers, skills, templates and agents are content-addressed and audited", () => {
    const docs = {
      providers: { protocol: "openai-compatible", baseUrl: "https://example.invalid/v1" },
      skills: { name: "Review", description: "Review carefully", content: "Check the result.\n" },
      templates: { title: "Bounded change", parameters: ["scope"] },
      agents: { adapter: "native", tier: "standard" },
    } as const;
    for (const kind of LIBRARY_KINDS) {
      const result = library.put(kind, `one-${kind}`, docs[kind], "ui:operator");
      assert.equal(result.changed, true);
      assert.match(result.entry.digest, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(library.get(kind, `one-${kind}`)?.document, { ...docs[kind], id: `one-${kind}` });
      assert.equal(existsSync(join(state, "library", kind, `one-${kind}`, "current.json")), true);
    }
    const events = journal.listEvents().filter((event) => event.entity === "library_change");
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.toState === "PUT" && (event.data as { actor: string }).actor === "ui:operator"));
    assert.equal(readFileSync(join(state, "library", "skills", "one-skills", "SKILL.md"), "utf8"), "Check the result.\n");
  });

  test("versions remain immutable, same bytes are idempotent, and deletion is an event", () => {
    const first = library.put("agents", "worker", { adapter: "native", tier: "cheap" }, "ui:operator");
    const duplicate = library.put("agents", "worker", { tier: "cheap", adapter: "native" }, "ui:operator");
    assert.equal(duplicate.changed, false, "canonical key order gives the same version");
    const second = library.put("agents", "worker", { adapter: "native", tier: "standard" }, "ui:operator");
    assert.notEqual(first.entry.digest, second.entry.digest);
    const versions = [first.entry.digest, second.entry.digest].map((digest) => join(state, "library", "agents", "worker", "versions", `${digest.slice(7)}.json`));
    assert.ok(versions.every(existsSync));
    assert.deepEqual(library.history("agents", "worker").map((item) => item.operation), ["PUT", "PUT"]);
    assert.equal(library.remove("agents", "worker", "ui:operator"), true);
    assert.equal(library.get("agents", "worker"), null);
    assert.equal(existsSync(join(state, "library", "agents", "worker", "current.json")), false);
    assert.deepEqual(library.history("agents", "worker").map((item) => item.operation), ["PUT", "PUT", "DELETE"]);
  });

  test("a skill rollback selects a digest from its own history and records operator context", () => {
    const original = library.put("skills", "review", { name: "Review", description: "v1", content: "Check risk." }, "ui:operator").entry;
    const newer = library.put("skills", "review", { name: "Review", description: "v2", content: "Check evidence." }, "ui:operator").entry;
    const restored = library.rollbackSkill("review", original.digest, "cli:operator", "v2 missed required risk checks");
    assert.equal(restored.digest, original.digest);
    assert.notEqual(newer.digest, restored.digest);
    assert.equal(library.get("skills", "review")?.digest, original.digest);
    assert.deepEqual(library.history("skills", "review").map(({ operation }) => operation), ["PUT", "PUT", "ROLLBACK"]);
    assert.deepEqual(library.history("skills", "review")[2], {
      seq: 3, operation: "ROLLBACK", digest: original.digest, actor: "cli:operator", reason: "v2 missed required risk checks",
    });
    assert.throws(() => library.rollbackSkill("review", newer.digest, "cli:operator", " "), /reason is required/);
    const other = library.put("skills", "other", { name: "Other", description: "Other", content: "No." }, "ui:operator").entry;
    assert.throws(() => library.rollbackSkill("review", other.digest, "cli:operator", "wrong skill"), /not in review's history/);
  });

  test("the ledger repairs an unlogged disk edit and rejects invalid identities", () => {
    const stored = library.put("templates", "review", { title: "Review" }, "ui:operator").entry;
    const current = join(state, "library", "templates", "review", "current.json");
    const version = join(state, "library", "templates", "review", "versions", `${stored.digest.slice(7)}.json`);
    writeFileSync(current, "{\"title\":\"forged\"}");
    writeFileSync(version, "{\"title\":\"forged version\"}");
    const reopened = new LibraryStore(state, journal);
    assert.deepEqual(JSON.parse(readFileSync(current, "utf8")), stored.document);
    assert.deepEqual(JSON.parse(readFileSync(version, "utf8")), stored.document);
    assert.throws(() => reopened.put("skills", "../escape", { content: "x" }, "ui:operator"), /invalid library id/);
    assert.throws(() => reopened.put("skills", "safe", { content: "x" }, " "), /actor is required/);
  });
});
