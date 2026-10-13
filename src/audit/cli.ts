// Read-only audit CLI over a run's journal. Output is JSON (stable ordering), one document per call.
//   node src/audit/cli.ts --state <stateDir> --run <runId> <command> [arg]
//   commands: verify [--head <hash>] | export | timeline [--task <id>] | who-changed <path>
//             why <actionId> | cost [--by profile|task|adapter|model|role] | waste | coordination

import { Journal } from "../journal/journal.ts";
import { coordination, costBy, exportLedger, orchestrationCost, timeline, verify, waste, whoChanged, why } from "./queries.ts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const state = opt("state");
const run = opt("run");
if (!state || !run || argv.length === 0) {
  console.error("usage: audit --state <stateDir> --run <runId> <verify|export|timeline|who-changed|why|cost|waste|coordination> [arg]");
  process.exit(2);
}
const [cmd, arg] = argv as [string, string | undefined];
const j = Journal.open(state, run);
let out: unknown;
switch (cmd) {
  case "verify":
    out = verify(j, opt("head"));
    break;
  case "export":
    out = exportLedger(j);
    break;
  case "timeline":
    out = timeline(j, { ...(opt("task") ? { taskId: opt("task") as string } : {}) });
    break;
  case "who-changed":
    out = whoChanged(j, arg ?? "");
    break;
  case "why":
    out = why(j, arg ?? "");
    break;
  case "cost":
    out = { by: costBy(j, (opt("by") as "profile") ?? "profile"), orchestration: orchestrationCost(j) };
    break;
  case "waste":
    out = waste(j);
    break;
  case "coordination":
    out = coordination(j);
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
j.close();
