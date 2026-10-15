// Plan 18 E2 (H2.4): the only way to regenerate the contract snapshots. The diff of a snapshot is the record of the change.
import { writeFileSync } from "node:fs";
import { CONFIG_TOOLS } from "../src/mcp/config-connector.ts";
import { agentRunsColumns, taskToolList } from "../test/contract/support.ts";

const golden = (name: string) => new URL(`../test/contract/golden/${name}`, import.meta.url);
const write = (name: string, value: unknown) => {
  writeFileSync(golden(name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote test/contract/golden/${name}`);
};

write("config-connector.tools.json", CONFIG_TOOLS);
write("task-connector.tools.json", await taskToolList());
write("agent-runs.columns.json", agentRunsColumns());
