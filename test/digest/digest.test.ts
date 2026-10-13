import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CanonicalError, canonicalJson, requestDigest, type RequestBody } from "../../src/digest/canonical.ts";
import { PatchRejected, resolveEdits } from "../../src/digest/edits.ts";
import { ABSENT, comparable, observeFile, sha256Bytes } from "../../src/digest/file.ts";
import { stateDigest } from "../../src/digest/state.ts";

const dir = () => mkdtempSync(join(tmpdir(), "digest-"));

describe("file digest", () => {
  test("known vectors; empty file is NOT absent", () => {
    assert.equal(sha256Bytes(Buffer.alloc(0)), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Bytes(Buffer.from("abc")), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const d = dir();
    writeFileSync(join(d, "empty"), "");
    assert.equal(comparable(observeFile(join(d, "empty"))), sha256Bytes(Buffer.alloc(0)));
    assert.equal(comparable(observeFile(join(d, "missing"))), ABSENT);
    assert.notEqual(ABSENT, sha256Bytes(Buffer.alloc(0)));
  });

  test("observation covers mode, binary bytes, and non-regular things", () => {
    const d = dir();
    writeFileSync(join(d, "bin"), Buffer.from([0, 255, 0, 1]), { mode: 0o755 });
    const o = observeFile(join(d, "bin"));
    assert.equal(o.kind, "file");
    if (o.kind === "file") {
      assert.equal(o.size, 4);
      assert.equal(o.mode, 0o755);
    }
    mkdirSync(join(d, "sub"));
    assert.deepEqual(observeFile(join(d, "sub")), { kind: "other", reason: "NOT_REGULAR" });
    symlinkSync(join(d, "bin"), join(d, "ln"));
    assert.deepEqual(observeFile(join(d, "ln")), { kind: "other", reason: "SYMLINK" });
    assert.equal(comparable(observeFile(join(d, "ln"))), null);
  });

  test("streams files larger than one read chunk", () => {
    const d = dir();
    const big = Buffer.alloc(200_000, 7);
    writeFileSync(join(d, "big"), big);
    assert.equal(comparable(observeFile(join(d, "big"))), sha256Bytes(big));
  });
});

describe("canonical JSON / request digest", () => {
  const body: RequestBody = {
    task_id: "t1",
    plan_revision: 1,
    expected_files: [
      { path: "b.py", digest: sha256Bytes(Buffer.from("b")) },
      { path: "a.py", digest: ABSENT },
    ],
    edits: [
      { op: "write_file", path: "b.py", content: "x" },
      { op: "replace_exact", path: "a.py", old: "1", new: "2" },
    ],
    declared_outputs: ["b.py", "a.py"],
  };

  test("key order and whitespace do not matter; floats and undefined are errors", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.throws(() => canonicalJson({ a: 1.5 }), CanonicalError);
    assert.throws(() => canonicalJson({ a: undefined }), CanonicalError);
    assert.throws(() => canonicalJson({ a: "\ud800" }), CanonicalError);
    assert.throws(() => canonicalJson(new Date()), CanonicalError);
  });

  test("set-like fields are order-insensitive; one changed byte changes the digest", () => {
    const d = requestDigest(body);
    const shuffled: RequestBody = {
      ...body,
      expected_files: [...body.expected_files].reverse(),
      edits: [...body.edits].reverse(),
      declared_outputs: [...body.declared_outputs].reverse(),
    };
    assert.equal(requestDigest(shuffled), d);
    const changed: RequestBody = { ...body, edits: [{ op: "write_file", path: "b.py", content: "y" }, body.edits[1]!] };
    assert.notEqual(requestDigest(changed), d);
  });

  test("order of edits on the SAME path is semantic and preserved", () => {
    const e1 = { op: "replace_exact", path: "a", old: "1", new: "2" } as const;
    const e2 = { op: "replace_exact", path: "a", old: "2", new: "3" } as const;
    const mk = (edits: RequestBody["edits"]): RequestBody => ({ ...body, edits });
    assert.notEqual(requestDigest(mk([e1, e2])), requestDigest(mk([e2, e1])));
  });

  test("incarnation is not part of the request (a retry after restart is the same body)", () => {
    // requestDigest picks its fields explicitly: a stray incarnation cannot influence it.
    const withExtra = { ...body, incarnation: 7 } as unknown as RequestBody;
    assert.equal(requestDigest(withExtra), requestDigest(body));
    assert.equal(requestDigest({ ...body, plan_revision: 2 }) === requestDigest(body), false);
  });
});

describe("state digest", () => {
  const a = { path: "a.py", digest: sha256Bytes(Buffer.from("a")), mode: 0o644 };
  const b = { path: "b.py", digest: sha256Bytes(Buffer.from("b")), mode: 0o644 };
  test("input order irrelevant; mode and path matter; absent is representable", () => {
    assert.equal(stateDigest([a, b]), stateDigest([b, a]));
    assert.notEqual(stateDigest([a, b]), stateDigest([{ ...a, mode: 0o755 }, b]));
    assert.notEqual(stateDigest([a]), stateDigest([{ ...a, path: "c.py" }]));
    assert.notEqual(stateDigest([a]), stateDigest([a, { path: "gone.py", digest: null, mode: null }]));
  });
  test("duplicates and malformed entries are errors", () => {
    assert.throws(() => stateDigest([a, a]));
    assert.throws(() => stateDigest([{ path: "x\ny", digest: null, mode: null }]));
    assert.throws(() => stateDigest([{ path: "x", digest: null, mode: 0o644 }]));
  });
});

describe("resolveEdits", () => {
  const views = (o: Record<string, string | null>) => new Map(Object.entries(o).map(([k, v]) => [k, v === null ? null : Buffer.from(v)]));
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof PatchRejected) return e.code;
      throw e;
    }
    return "NO_ERROR";
  };

  test("replace, create and delete are classified and produce final bytes", () => {
    const r = resolveEdits(views({ "a.py": "x = 1\n", "n.py": null, "d.py": "bye" }), [
      { op: "replace_exact", path: "a.py", old: "1", new: "2" },
      { op: "write_file", path: "n.py", content: "new\n" },
      { op: "delete_file", path: "d.py" },
    ]);
    const by = Object.fromEntries(r.map((x) => [x.path, x]));
    assert.equal(by["a.py"]?.op, "replace");
    assert.equal(by["a.py"]?.after?.toString(), "x = 2\n");
    assert.equal(by["n.py"]?.op, "create");
    assert.equal(by["d.py"]?.op, "delete");
    assert.equal(by["d.py"]?.after, null);
  });

  test("S03-adjacent rejections write nothing: missing, ambiguous, empty, blind, conflicting", () => {
    const v = views({ "a.py": "aa bb aa", "n.py": null });
    assert.equal(code(() => resolveEdits(v, [{ op: "replace_exact", path: "a.py", old: "zz", new: "" }])), "PATCH_DOES_NOT_APPLY");
    assert.equal(code(() => resolveEdits(v, [{ op: "replace_exact", path: "a.py", old: "aa", new: "" }])), "PATCH_AMBIGUOUS");
    assert.equal(code(() => resolveEdits(v, [{ op: "replace_exact", path: "a.py", old: "", new: "x" }])), "EMPTY_OLD");
    assert.equal(code(() => resolveEdits(v, [{ op: "replace_exact", path: "n.py", old: "a", new: "b" }])), "PATCH_DOES_NOT_APPLY");
    assert.equal(code(() => resolveEdits(v, [{ op: "write_file", path: "unseen.py", content: "x" }])), "PATCH_DOES_NOT_APPLY");
    assert.equal(code(() => resolveEdits(v, [{ op: "delete_file", path: "n.py" }])), "PATCH_DOES_NOT_APPLY");
    assert.equal(
      code(() => resolveEdits(v, [{ op: "delete_file", path: "a.py" }, { op: "write_file", path: "a.py", content: "" }])),
      "PATCH_CONFLICTING_OPS",
    );
  });

  test("non-UTF-8 content cannot be edited textually; oversized results are refused", () => {
    const bin = new Map([["b.bin", Buffer.from([0xff, 0xfe, 0x00])]]);
    assert.equal(code(() => resolveEdits(bin, [{ op: "replace_exact", path: "b.bin", old: "a", new: "b" }])), "PATCH_NOT_UTF8");
    const v = views({ "a.py": "x" });
    assert.equal(code(() => resolveEdits(v, [{ op: "write_file", path: "a.py", content: "y".repeat(1024 * 1024 + 1) }])), "FILE_TOO_LARGE");
  });

  test("sequential edits on one path apply in order", () => {
    const r = resolveEdits(views({ "a.py": "one" }), [
      { op: "replace_exact", path: "a.py", old: "one", new: "two" },
      { op: "replace_exact", path: "a.py", old: "two", new: "three" },
    ]);
    assert.equal(r[0]?.after?.toString(), "three");
  });
});
