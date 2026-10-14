// Summarise docs/plans/14-seguimiento.md and fail on inconsistent bookkeeping.
//   node scripts/plan-status.ts [file]
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? new URL("../docs/plans/14-seguimiento.md", import.meta.url).pathname;
const lines = readFileSync(file, "utf8").split("\n");
const MARK = { " ": "pendiente", "~": "en curso", x: "hecha", "!": "bloqueada" } as const;
type Mark = keyof typeof MARK;

let section = "";
const per = new Map<string, Record<string, number>>();
const problems: string[] = [];
const ids = new Set<string>();
for (let i = 0; i < lines.length; i++) {
  const l = lines[i] as string;
  const h = /^### (.+)$/.exec(l);
  if (h) section = h[1] as string;
  const m = /^- \[([ ~x!])\] ([A-Z]+\.?\d+(?:\.\d+)?) (.*)$/.exec(l);
  if (!m) continue;
  const [, mark, id] = m as unknown as [string, Mark, string];
  if (ids.has(id)) problems.push(`línea ${i + 1}: id duplicado ${id}`);
  ids.add(id);
  // a task continues on the following indented lines
  let body = l;
  for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j] as string); j++) body += " " + (lines[j] as string).trim();
  if (mark === "x" && !/commit:\s*[0-9a-f]{7,}/.test(body)) problems.push(`${id}: marcada hecha sin "commit: <hash>"`);
  if (mark === "!" && !/motivo:/i.test(body)) problems.push(`${id}: bloqueada sin "motivo:"`);
  if (mark === "~" && !/(quién|desde):/i.test(body)) problems.push(`${id}: en curso sin "quién:" ni "desde:"`);
  const row = per.get(section) ?? { pendiente: 0, "en curso": 0, hecha: 0, bloqueada: 0 };
  row[MARK[mark]]!++;
  per.set(section, row);
}
let total = 0;
let done = 0;
for (const [s, r] of per) {
  const n = Object.values(r).reduce((a, b) => a + b, 0);
  total += n;
  done += r["hecha"]!;
  console.log(`${s}\n   hecha ${r["hecha"]}/${n} · en curso ${r["en curso"]} · pendiente ${r["pendiente"]} · bloqueada ${r["bloqueada"]}`);
}
console.log(`\nTotal: ${done}/${total} hechas`);
if (problems.length) {
  console.error(`\n${problems.length} problema(s):\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
}
