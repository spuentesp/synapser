// X1 (plan 16, P16.2): the tool surface a client sees is the one pinned in fixtures/tool-surface.json, per role.
// The snapshot was taken from the hand-written server before the SDK swap; a change to a name, a description or a
// schema fails here, and the change must then be made on purpose and the snapshot regenerated with it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";

const pinned = JSON.parse(readFileSync(new URL("./fixtures/tool-surface.json", import.meta.url), "utf8")) as Record<string, unknown>;
const stub = {} as never; // tools/list never touches the manager or the journal

describe("X1: the tool surface is the pinned one, per role (plan 16, P16.2)", () => {
  for (const role of ["initiator", "worker"] as const) {
    test(`${role}: tools/list equals the snapshot`, async () => {
      const srv = new McpServer({ manager: stub, serverJournal: stub, role });
      assert.deepEqual(await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }), pinned[role]);
    });
  }
});
