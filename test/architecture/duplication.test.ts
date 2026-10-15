import assert from "node:assert/strict";
import { test } from "node:test";
import { findDuplicatedBlocks } from "../../scripts/duplication.ts";

test("H12.4 reports repeated normalized windows without imposing a threshold", () => {
  const block = Array.from({ length: 3 }, (_, index) => `const item${index} = ${index};`).join("\n");
  const duplicates = findDuplicatedBlocks({ "a.ts": `// ignored\n${block}\n`, "b.ts": `${block}\n` }, 3);
  assert.deepEqual(duplicates, [[{ file: "a.ts", line: 2 }, { file: "b.ts", line: 1 }]]);
  assert.deepEqual(findDuplicatedBlocks({ "a.ts": block, "b.ts": "const other = true;\nconst item1 = 1;\nconst item2 = 2;" }, 3), []);
});
