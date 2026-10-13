import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PathRejected, resolveInWorkspace, resolveSet } from "../../src/workspace/paths.ts";
import { tempWorkspace } from "../helpers.ts";

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e) => e instanceof PathRejected && e.code === code, `expected ${code}`);

test("S15: contained paths are canonicalized to workspace-relative POSIX", () => {
  const ws = tempWorkspace({ "app/billing.py": "x", "app/schema.py": "y" });
  assert.equal(resolveInWorkspace(ws, "app/billing.py"), "app/billing.py");
  assert.equal(resolveInWorkspace(ws, "./app/../app/billing.py"), "app/billing.py");
  assert.equal(resolveInWorkspace(ws, join(ws, "app/schema.py")), "app/schema.py");
  assert.equal(resolveInWorkspace(ws, "app/new_file.py"), "app/new_file.py"); // not yet existing is fine
});

test("S15: escapes, absolute outside paths and reserved names are rejected before any claim", () => {
  const ws = tempWorkspace({ "a.txt": "a" });
  rejects(() => resolveInWorkspace(ws, "/etc/passwd"), "OUTSIDE_WORKSPACE");
  rejects(() => resolveInWorkspace(ws, "../x"), "OUTSIDE_WORKSPACE");
  rejects(() => resolveInWorkspace(ws, "a/../../x"), "OUTSIDE_WORKSPACE");
  rejects(() => resolveInWorkspace(ws, "."), "OUTSIDE_WORKSPACE");
  rejects(() => resolveInWorkspace(ws, ".git/config"), "RESERVED");
  rejects(() => resolveInWorkspace(ws, ".zoanthrope/state.json"), "RESERVED");
  rejects(() => resolveInWorkspace(ws, ".synapser/journal.db"), "RESERVED");
  rejects(() => resolveInWorkspace(ws, ""), "EMPTY");
  rejects(() => resolveInWorkspace(ws, "a\0b"), "NUL_BYTE");
});

test("S15: symlinks (file, parent dir, escaping) are rejected in the MVP", () => {
  const ws = tempWorkspace({ "real/x.txt": "x" });
  symlinkSync(join(ws, "real"), join(ws, "link"));
  symlinkSync("/etc/hostname", join(ws, "out.txt"));
  rejects(() => resolveInWorkspace(ws, "link/x.txt"), "SYMLINK");
  rejects(() => resolveInWorkspace(ws, "out.txt"), "SYMLINK");
  mkdirSync(join(ws, "dir"));
  rejects(() => resolveInWorkspace(ws, "dir"), "NOT_A_FILE");
});

test("resolveSet de-duplicates and sorts for stable traces", () => {
  const ws = tempWorkspace({ "b.py": "", "a.py": "" });
  assert.deepEqual(resolveSet(ws, ["b.py", "./a.py", "b.py"]), ["a.py", "b.py"]);
});
