// Verify a ledger export OFFLINE: no database, no server, only the file.
//   node scripts/verify-export.ts <run>.ledger.json
import { readFileSync } from "node:fs";
import { verifyChain } from "../src/audit/chain.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-export.ts <export.json>");
  process.exit(2);
}
const doc = JSON.parse(readFileSync(file, "utf8")) as { head: string; events: { runId: string; seq: number; prevHash: string; hash: string }[] };
const runId = doc.events[0]?.runId;
if (!runId) {
  console.error("empty export");
  process.exit(2);
}
const v = verifyChain(runId, doc.events as never, doc.head);
console.log(JSON.stringify(v, null, 2));
process.exit(v.ok ? 0 : 1);
