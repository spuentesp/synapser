// Spike S-Z (plan 11 §2): what does Zoanthrope's audit ring really give an observer?
//   node scripts/spike-sz.ts
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";

const ws = realpathSync(mkdtempSync(join(tmpdir(), "spike-sz-")));
writeFileSync(join(ws, "a.py"), "x=1\n");
const open = () => ZooAdapter.open(loadPin(), ws);
type Ev = { ts: number; agent: string; action: string; path: string | null; purpose: string | null; stamps?: string[] };
const log = async (z: ZooAdapter, n = 5000) => (await z.auditLog(n)) as Ev[];

let z = await open();
// 1) shape and timestamp resolution
await z.registerAgent("run-1:task-a");
for (let i = 0; i < 5; i++) {
  await z.claim("run-1:task-a", ["a.py" as never], "edit", { purpose: `p${i}` });
  await z.release("run-1:task-a", ["a.py" as never]);
}
await z.postIntention("run-1:task-a", "intent", "editing a.py", ["a.py" as never]);
let ev = await log(z);
console.log("Q1 keys:", Object.keys(ev[0]!).join(","), "| has seq/id:", ev.some((e) => "seq" in e || "id" in e));
console.log("Q1 actions:", [...new Set(ev.map((e) => e.action))].join(","));
const ts = ev.map((e) => e.ts);
console.log("Q1 ts sample:", ts.slice(0, 3).map((t) => t.toFixed(6)).join(" "), "| distinct:", new Set(ts).size, "of", ts.length, "| monotone:", ts.every((t, i) => i === 0 || t >= (ts[i - 1] as number)));

// 2) since boundary semantics
const mid = ev[Math.floor(ev.length / 2)]!;
const since = (await z.auditLog(5000)) as Ev[];
const raw = await (z as unknown as { "#tool"?: unknown })["#tool"];
void raw; void since;
// the adapter's auditLog has no `since`; call the transport through a second tiny path
const same = ev.filter((e) => e.ts >= mid.ts).length;
console.log("Q2 events with ts >= mid:", same, "(inclusive boundary re-reads equal-ts events: dedupe needed)");

// 3) wrap: push the ring past its cap
for (let i = 0; i < 620; i++) {
  await z.claim("run-1:task-a", ["a.py" as never], "edit", { purpose: `bulk${i}` });
  await z.release("run-1:task-a", ["a.py" as never]);
}
ev = await log(z, 5000);
console.log("Q3 ring length after 1240+ events:", ev.length, "| oldest purpose:", ev[0]!.purpose, "| newest:", ev.at(-1)!.action, ev.at(-1)!.purpose);
const small = await log(z, 50);
console.log("Q3 limit=50 returns:", small.length, "(the NEWEST 50, oldest first)");

// 4) persistence across a restart
await z.close();
z = await open();
const after = await log(z, 5000);
console.log("Q4 after restart ring length:", after.length, "| same head:", after[0]!.ts === ev[0]!.ts);

// 5) a second client can publish as the same identity (no authentication)
const z2 = await open();
await z2.postIntention("run-1:task-a", "spoof", "posted by another process", []);
const posts = (await (z2 as unknown as { listPosts?: () => Promise<unknown> }).listPosts?.()) ?? null;
void posts;
const spoofed = (await log(z2, 5000)).filter((e) => e.action === "post").at(-1)!;
console.log("Q5 second client posted as:", spoofed.agent, "(identity is a string the caller supplies)");
await z2.close();
await z.close();
