// Plan 18 E12 (H12.4): duplicated blocks in src/. A block is 12 consecutive non-blank lines, compared after trimming.
// H12.4 threshold: no block of 12 lines may be duplicated in src/ (the measured count when the threshold was set was 0).
// The report lists the blocks; the run fails above the threshold.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const WINDOW = 12;
const MAX_DUPLICATED_BLOCKS = 0;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

const blocks = new Map<string, { file: string; line: number }[]>();
for (const file of files(join(root, "src"))) {
  const lines = readFileSync(file, "utf8").split("\n").map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text && !l.text.startsWith("//"));
  for (let i = 0; i + WINDOW <= lines.length; i++) {
    const key = lines.slice(i, i + WINDOW).map((l) => l.text).join("\n");
    const list = blocks.get(key) ?? [];
    list.push({ file: relative(root, file), line: lines[i]!.line });
    blocks.set(key, list);
  }
}

const dup = [...blocks.values()].filter((list) => list.length > 1 && new Set(list.map((b) => b.file)).size >= 1 && list.length > 1);
const report = [
  `duplicated blocks of ${WINDOW} lines in src/: ${dup.length}`,
  ...dup.slice(0, 200).map((list) => `- ${list.map((b) => `${b.file}:${b.line}`).join(" = ")}`),
].join("\n");
mkdirSync(new URL("../evidence/architecture/", import.meta.url), { recursive: true });
writeFileSync(new URL("../evidence/architecture/duplication.txt", import.meta.url), `${report}\n`);
console.log(report.split("\n")[0]);
if (dup.length > MAX_DUPLICATED_BLOCKS) {
  console.error(`✖ ${dup.length} duplicated blocks; the threshold is ${MAX_DUPLICATED_BLOCKS}. See evidence/architecture/duplication.txt`);
  process.exit(1);
}
