import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validate } from "../../src/agents/native/schema.ts";
import { normalizeArgs, TOOL_SCHEMAS, TOOL_SPECS } from "../../src/agents/native/tools.ts";

const errs = (tool: string, args: unknown) => validate(normalizeArgs(tool, args).args, TOOL_SCHEMAS[tool]!);

describe("tool surface", () => {
  test("is flat: no nested arrays of objects, no identity, no shell", () => {
    const names = TOOL_SPECS.map((t) => t.function.name);
    assert.deepEqual(names, ["read_files", "write_file", "replace_in_file", "delete_file", "apply_changes", "finish"]);
    const text = JSON.stringify(TOOL_SPECS);
    for (const banned of ["task_id", "actor", "incarnation", "digest\":", "view_id", "shell", "exec", "command"]) {
      assert.equal(text.includes(banned), false, `tool specs mention ${banned}`);
    }
    for (const t of TOOL_SPECS) {
      const props = (t.function.parameters as { properties?: Record<string, { type?: string; items?: { type?: string } }> }).properties ?? {};
      for (const p of Object.values(props)) assert.ok(p.type !== "array" || p.items?.type === "string", "arrays hold strings only");
    }
  });
});

describe("normalizeArgs (observed model quirks; never widening what is allowed)", () => {
  test("near-synonym keys are recovered and reported", () => {
    assert.deepEqual(errs("write_file", { file: "a.py", new_content: "x" }), []);
    assert.deepEqual(errs("replace_in_file", { file_path: "a.py", old_str: "a", new_str: "b" }), []);
    assert.deepEqual(errs("read_files", { files: ["a.py"] }), []);
    assert.deepEqual(errs("read_files", { paths: "a.py" }), []);
    assert.deepEqual(errs("read_files", { paths: '["a.py","b.py"]' }), []);
    assert.deepEqual(normalizeArgs("write_file", { file: "a.py", new_content: "x" }).notes.sort(), ["write_file.file → path", "write_file.new_content → content"]);
  });

  test("an alias never overrides a field that is already there", () => {
    const n = normalizeArgs("write_file", { path: "a.py", content: "real", text: "other" });
    assert.equal((n.args as { content: string }).content, "real");
    assert.ok(validate(n.args, TOOL_SCHEMAS["write_file"]!).length > 0, "the leftover `text` is rejected, not silently dropped");
  });

  test("nothing can be smuggled: unknown tools' fields, extra properties, empty paths, wrong types", () => {
    assert.ok(errs("write_file", { path: "a.py", content: "x", mode: "0777" }).length > 0);
    assert.ok(errs("write_file", { path: "", content: "x" }).length > 0);
    assert.ok(errs("write_file", { path: "a.py", content: 5 }).length > 0);
    assert.ok(errs("replace_in_file", { path: "a.py", old: "", new: "b" }).length > 0, "empty `old` would match everywhere");
    assert.ok(errs("apply_changes", { action_id: "act-1" }).length > 0);
    assert.ok(errs("read_files", { paths: [] }).length > 0);
    assert.ok(errs("read_files", { paths: Array.from({ length: 21 }, (_, i) => `f${i}`) }).length > 0);
    assert.deepEqual(errs("apply_changes", {}), []);
  });
});
