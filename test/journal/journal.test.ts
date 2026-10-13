import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { sha256Bytes } from "../../src/digest/file.ts";
import {
  IllegalTransition,
  Journal,
  JournalError,
  type NewAction,
  type NewActionFile,
  TransitionConflict,
} from "../../src/journal/journal.ts";

const RUN = "run-1";
const digest = (s: string) => sha256Bytes(Buffer.from(s));
const action = (id: string, over: Partial<NewAction> = {}): NewAction => ({
  runId: RUN,
  actionId: id,
  taskId: "t1",
  actorOwner: `${RUN}:t1`,
  incarnation: 1,
  planRevision: 1,
  requestDigest: digest(`req-${id}`),
  ...over,
});
const file = (path: string): NewActionFile => ({
  path,
  op: "replace",
  beforeDigest: digest(`${path}-before`),
  afterDigest: digest(`${path}-after`),
  beforeMode: 0o644,
  afterMode: 0o644,
  beforeBlob: digest(`${path}-before`),
  afterBlob: digest(`${path}-after`),
  tmpName: `.synapser-tmp-${path.replace(/\W/g, "_")}`,
});

describe("journal", () => {
  let dir: string;
  let j: Journal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-"));
    j = Journal.open(dir, RUN);
  });
  afterEach(() => j.close());

  test("insert is atomic with its event and sorted by path", () => {
    const out = j.tx((t) => t.insertAction(action("a1"), [file("z.py"), file("a.py")]));
    assert.deepEqual(out, { kind: "created" });
    assert.equal(j.getAction("a1")?.state, "PREPARED");
    assert.deepEqual(j.getActionFiles("a1").map((f) => f.path), ["a.py", "z.py"]);
    const ev = j.listEvents();
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]?.entity, ev[0]?.fromState, ev[0]?.toState], ["action", null, "PREPARED"]);
  });

  test("same key + same digest → duplicate (with receipt); other body → digest_conflict", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    j.tx((t) => {
      t.transition(RUN, "a1", "PREPARED", "CLAIMING");
      t.transition(RUN, "a1", "CLAIMING", "CLAIMED");
      t.transition(RUN, "a1", "CLAIMED", "EXECUTING");
      t.transition(RUN, "a1", "EXECUTING", "APPLIED", { receipt: { applied_files: ["a.py"] } });
    });
    const dup = j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    assert.deepEqual(dup, { kind: "duplicate", state: "APPLIED", receipt: { applied_files: ["a.py"] } });
    const conflict = j.tx((t) => t.insertAction(action("a1", { requestDigest: digest("other body") }), [file("a.py")]));
    assert.equal(conflict.kind, "digest_conflict");
    // an incarnation bump alone is not a different body (digest excludes it)
    const retried = j.tx((t) => t.insertAction(action("a1", { incarnation: 2 }), [file("a.py")]));
    assert.equal(retried.kind, "duplicate");
  });

  test("a throw inside tx rolls back state AND event", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    const before = j.listEvents().length;
    assert.throws(
      () =>
        j.tx((t) => {
          t.transition(RUN, "a1", "PREPARED", "CLAIMING");
          throw new Error("boom");
        }),
      JournalError,
    );
    assert.equal(j.getAction("a1")?.state, "PREPARED");
    assert.equal(j.listEvents().length, before);
  });

  test("CAS: a second transition from a stale expectation fails with the actual state", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    j.tx((t) => t.transition(RUN, "a1", "PREPARED", "CLAIMING"));
    try {
      j.tx((t) => t.transition(RUN, "a1", "PREPARED", "CLAIMING"));
      assert.fail("expected conflict");
    } catch (e) {
      assert.ok(e instanceof TransitionConflict);
      assert.equal(e.actual, "CLAIMING");
    }
    assert.throws(() => j.tx((t) => t.transition(RUN, "nope", "PREPARED", "CLAIMING")), TransitionConflict);
  });

  test("illegal transitions are refused by the code AND, independently, by the database", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    assert.throws(() => j.tx((t) => t.transition(RUN, "a1", "PREPARED", "APPLIED")), IllegalTransition);
    assert.throws(
      () => j.rawForTests.prepare("UPDATE actions SET state='APPLIED' WHERE action_id='a1'").run(),
      /illegal action transition/,
    );
    assert.equal(j.getAction("a1")?.state, "PREPARED");
  });

  test("events are append-only; action identity and file plan are immutable", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    const raw = j.rawForTests;
    assert.throws(() => raw.exec("UPDATE events SET entity='x'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM events"), /append-only/);
    assert.throws(() => raw.exec("UPDATE actions SET request_digest='sha256:00'"), /immutable/);
    assert.throws(() => raw.exec("UPDATE actions SET actor_owner='someone-else'"), /immutable/);
    assert.throws(() => raw.exec("DELETE FROM actions"), /never deleted/);
    assert.throws(() => raw.exec("UPDATE action_files SET after_digest='sha256:00'"), /immutable/);
    // progress and observed_digest are the only mutable columns of action_files
    assert.doesNotThrow(() => raw.exec("UPDATE action_files SET progress='APPLIED', observed_digest='sha256:00'"));
  });

  test("fs_cleanup can never be anything but NOT_ATTESTED", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    assert.throws(() => j.rawForTests.exec("UPDATE actions SET fs_cleanup='CLEARED'"), /CHECK/);
  });

  test("event seq is contiguous and survives reopen", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    j.tx((t) => t.transition(RUN, "a1", "PREPARED", "CLAIMING", { bumpAttempt: true }));
    j.tx((t) => t.transition(RUN, "a1", "CLAIMING", "WAITING_RESOURCE", { errorCode: "CONFLICT", event: { holder: "beta" } }));
    j.close();
    j = Journal.open(dir, RUN);
    const seqs = j.listEvents().map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3]);
    assert.equal(j.getAction("a1")?.attempt, 1);
    assert.equal(j.getAction("a1")?.errorCode, "CONFLICT");
    assert.deepEqual(j.listEvents()[2]?.data, { error_code: "CONFLICT", holder: "beta" });
    j.tx((t) => t.transition(RUN, "a1", "WAITING_RESOURCE", "CLAIMING"));
    assert.equal(j.listEvents().at(-1)?.seq, 4);
  });

  test("listNonTerminal excludes SETTLED and REJECTED", () => {
    j.tx((t) => {
      t.insertAction(action("a1"), [file("a.py")]);
      t.insertAction(action("a2"), [file("b.py")]);
    });
    j.tx((t) => t.transition(RUN, "a2", "PREPARED", "REJECTED", { errorCode: "PATCH_AMBIGUOUS" }));
    assert.deepEqual(j.listNonTerminal().map((a) => a.actionId), ["a1"]);
  });

  test("invalid run ids are refused (they become a directory name)", () => {
    assert.throws(() => Journal.open(dir, "../escape"), JournalError);
    assert.throws(() => Journal.open(dir, ""), JournalError);
  });

  test("markFileApplied records progress and an event", () => {
    j.tx((t) => t.insertAction(action("a1"), [file("a.py")]));
    j.tx((t) => t.markFileApplied(RUN, "a1", "a.py", digest("a.py-after")));
    assert.equal(j.getActionFiles("a1")[0]?.progress, "APPLIED");
    assert.equal(j.listEvents().at(-1)?.entity, "action_file");
  });
});
