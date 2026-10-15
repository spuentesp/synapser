// A real executor process that can be killed at a named failpoint (plan 04 §7).
// Usage: node executor-child.ts <stateDir> <workspace> <scenario>
// Prints one JSON object per line so the parent can see how far it got before dying.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Edit } from "../../src/digest/canonical.ts";
import { Executor } from "../../src/executor/executor.ts";
import { simulatedWorkspaceDurability } from "../recovery/disk.ts";
import { envFailpoint } from "../../src/failpoints.ts";
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../../src/journal/lock.ts";
import { ZooAdapter } from "../../src/zoo/adapter.ts";
import { loadPin } from "../../src/zoo/pin.ts";

const [stateDir, ws, scenario] = process.argv.slice(2) as [string, string, string];
const RUN = "run-42";
const say = (o: unknown) => console.log(JSON.stringify(o));

const lock = acquireWorkspaceLock(stateDir, ws);
const journal = Journal.open(stateDir, RUN);
const zoo = await ZooAdapter.open(loadPin(), ws);
const durableSnapshot = process.env["SYNAPSER_DURABLE_SNAPSHOT"];
const diskFault = process.env["SYNAPSER_DISK_SYNC_FAULT"];
const diskTrace = process.env["SYNAPSER_DISK_SYNC_TRACE"];
const exec = new Executor({
  workspace: ws,
  runId: RUN,
  journal,
  zoo,
  generation: lock.generation,
  failpoint: envFailpoint(),
  ...(durableSnapshot && diskFault && diskTrace ? { workspaceDurability: simulatedWorkspaceDurability(ws, durableSnapshot, diskFault, diskTrace) } : {}),
});

const task = { taskId: "t1", scope: ["app/billing.py", "app/client.py", "app/schema.py"], planRevision: 1 };
const { incarnation } = exec.beginSession(task);
const edits: Edit[] = [
  { op: "write_file", path: "app/billing.py", content: '"""billing v2"""\n' },
  {
    op: "replace_exact",
    path: "app/schema.py",
    old: "class Invoice:\n    customer_id: str\n    subtotal_cents: int\n",
    new: "class Invoice:\n    customer_id: str\n    subtotal_cents: int\n    discount_bps: int = 0\n",
  },
];
if (scenario === "three-files") {
  edits.push({ op: "write_file", path: "app/client.py", content: '"""client v2"""\n' });
}
const readPaths = scenario === "three-files" ? ["app/billing.py", "app/client.py", "app/schema.py"] : ["app/billing.py", "app/schema.py"];
const read = await exec.readFiles("t1", incarnation, readPaths);
if (read.kind !== "ok") throw new Error(`read ${JSON.stringify(read)}`);
const p = await exec.proposePatch("t1", incarnation, read.viewId, edits);
if (p.kind !== "ok") throw new Error(`propose ${JSON.stringify(p)}`);
say({ event: "proposed", actionId: p.actionId, requestDigest: p.requestDigest, incarnation });

if (scenario === "stale") {
  // someone edits the file between read and apply
  writeFileSync(join(ws, "app", "billing.py"), "# edited out of band\n");
}
const r = await exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation });
say({ event: "receipt", status: r.status, state: r.state });
await zoo.close();
journal.close();
lock.release();
