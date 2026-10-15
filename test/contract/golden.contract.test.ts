import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CONFIG_TOOLS } from "../../src/mcp/config-connector.ts";
import { agentRunsColumns, taskToolList } from "./support.ts";
import { breakingChanges, type ToolShape } from "./compat.ts";

// Plan 18 E2: the snapshots match what the code emits (C-CFG-TOOL-1, C-MCP-TASK-1, C-LEDGER-1) and a change to them is
// classified (H2.5). A snapshot changes only through npm run contracts:update, so its diff is the record.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./golden/${name}`, import.meta.url), "utf8"));

describe("C-MCP-TASK-1: the task connector's tools", () => {
  test("the tool list equals its snapshot", async () => {
    assert.deepEqual(await taskToolList(), read("task-connector.tools.json"));
  });

  test("it lists 18 tools and no configuration tool (K3)", async () => {
    const names = (await taskToolList()).map((t) => t.name);
    assert.equal(names.length, 18);
    assert.equal(names.some((n) => n.startsWith("config_")), false);
  });
});

describe("C-LEDGER-1: the agent run record", () => {
  test("the columns equal the snapshot, and the injection record is among them", () => {
    const columns = agentRunsColumns();
    assert.deepEqual(columns, read("agent-runs.columns.json"));
    assert.ok(columns.includes("injection_json"));
  });
});

describe("H2.5: compatibility of the configuration tools", () => {
  test("the committed snapshot is compatible with the one in the previous commit", () => {
    let previous: ToolShape[];
    try {
      previous = JSON.parse(execFileSync("git", ["show", "HEAD:test/contract/golden/config-connector.tools.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return; // no earlier snapshot in history yet
    }
    assert.deepEqual(breakingChanges(previous, CONFIG_TOOLS as unknown as ToolShape[]), []);
  });

  test("a removed tool, a removed property, a retyped property and a new required property are breaking", () => {
    const before: ToolShape[] = [{ name: "t", inputSchema: { properties: { a: { type: "string" }, b: { type: "object" } }, required: ["a"] } }, { name: "gone" }];
    const after: ToolShape[] = [{ name: "t", inputSchema: { properties: { a: { type: "number" }, c: { type: "string" } }, required: ["a", "c"] } }];
    const found = breakingChanges(before, after);
    assert.ok(found.includes("tool gone was removed"));
    assert.ok(found.includes("t: property a changed type"));
    assert.ok(found.includes("t: property b was removed"));
    assert.ok(found.includes("t: c is now required"));
  });

  test("an optional new property and a new tool are compatible", () => {
    const before: ToolShape[] = [{ name: "t", inputSchema: { properties: { a: { type: "string" } }, required: ["a"] } }];
    const after: ToolShape[] = [{ name: "t", inputSchema: { properties: { a: { type: "string" }, extra: { type: "string" } }, required: ["a"] } }, { name: "new" }];
    assert.deepEqual(breakingChanges(before, after), []);
  });
});
