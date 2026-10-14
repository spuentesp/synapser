// Regenerates fixtures/validation-golden.json from the corpus, with the library's validation as it is in this checkout.
// Run it on purpose only: the golden is the reference the zod schemas must reproduce (plan 16, P16.3). A changed golden
// is a changed behaviour, and the commit that changes it says why.
//   node test/library/regen-validation-golden.ts

import { writeFileSync } from "node:fs";
import { resolveAgent, validateLibraryDocument } from "../../src/library/validate.ts";
import { cases, POLICIES } from "./validation-corpus.ts";

const rows = cases().map((c) => {
  const policy = POLICIES[c.policy];
  const output = validateLibraryDocument(c.kind, c.id, c.document, policy);
  const row: Record<string, unknown> = { name: c.name, kind: c.kind, id: c.id, policy: c.policy, document: c.document, output };
  if (c.kind === "agents" && output.length === 0) {
    row["profile"] = JSON.parse(JSON.stringify(resolveAgent(`agents/${c.id}`, c.id, c.document as Record<string, unknown>, policy).profile));
  }
  return row;
});
writeFileSync(new URL("./fixtures/validation-golden.json", import.meta.url), `${JSON.stringify(rows, null, 1)}\n`);
console.log(`${rows.length} cases; ${rows.filter((r) => (r["output"] as unknown[]).length === 0).length} valid`);
