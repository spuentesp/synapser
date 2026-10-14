// Plan 16, P16.3: what the library's validation says about each corpus case, before and after the zod schemas. The golden
// was generated from main at 73991d1, before the schemas, by regen-validation-golden.ts. Regenerating it is a deliberate
// change, as the X1 snapshot is: a difference here is a change of behaviour, not a fixture to refresh. Messages are
// compared sorted, since the order they come in is not a contract: every problem is reported, in any order.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { resolveAgent, validateLibraryDocument } from "../../src/library/validate.ts";
import { POLICIES } from "./validation-corpus.ts";

interface Row {
  name: string;
  kind: "agents" | "skills" | "providers" | "templates";
  id: string;
  policy: "bare" | "full";
  document: unknown;
  output: string[];
  profile?: unknown;
}

const rows = JSON.parse(readFileSync(new URL("./fixtures/validation-golden.json", import.meta.url), "utf8")) as Row[];
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("P16.3: the library validates as it did before zod (golden from main at 73991d1)", () => {
  test("the golden covers every kind, valid and refused cases, and a pinned profile", () => {
    assert.ok(rows.length >= 200, `${rows.length} cases`);
    for (const kind of ["agents", "skills", "providers", "templates"] as const) {
      assert.ok(rows.some((r) => r.kind === kind && r.output.length === 0), `${kind} has a valid case`);
      assert.ok(rows.some((r) => r.kind === kind && r.output.length > 0), `${kind} has a refused case`);
    }
    assert.ok(rows.some((r) => r.kind === "agents" && r.profile !== undefined), "a valid agent pins its profile");
  });

  rows.forEach((row, i) =>
    test(`${i}: ${row.kind}: ${row.name}`, () => {
      const got = validateLibraryDocument(row.kind, row.id, row.document, POLICIES[row.policy]);
      assert.deepEqual(sorted(got), sorted(row.output));
      if (row.profile !== undefined) {
        const profile = resolveAgent(`agents/${row.id}`, row.id, row.document as Record<string, unknown>, POLICIES[row.policy]).profile;
        assert.deepEqual(JSON.parse(JSON.stringify(profile)), row.profile, "the profile a run uses");
      }
    }),
  );
});
