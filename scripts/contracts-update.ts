// Plan 18 E2 (H2.4): the only way to regenerate the contract snapshots. The diff of the snapshot is the record of the change.
import { writeFileSync } from "node:fs";
import { CONFIG_TOOLS } from "../src/mcp/config-connector.ts";

const path = new URL("../test/contract/golden/config-connector.tools.json", import.meta.url);
writeFileSync(path, `${JSON.stringify(CONFIG_TOOLS, null, 2)}\n`);
console.log(`wrote ${path.pathname}`);
