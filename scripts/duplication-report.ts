// Plan 18 E12 (H12.4): report duplicated blocks in src/. This is informational until an operator-approved threshold exists.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findDuplicatedBlocks } from "./duplication.ts";
import { resolveEvidenceRoot } from "./evidence-path.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

const sources = Object.fromEntries(files(join(root, "src")).map((file) => [relative(root, file), readFileSync(file, "utf8")]));
const dup = findDuplicatedBlocks(sources, 12);
const report = [
  "duplicated blocks of 12 lines in src/ (informational; no blocking threshold is configured)",
  ...dup.slice(0, 200).map((list) => `- ${list.map((b) => `${b.file}:${b.line}`).join(" = ")}`),
].join("\n");
const architectureEvidenceDir = join(resolveEvidenceRoot(root, process.env["SYNAPSER_EVIDENCE_DIR"]), "architecture");
mkdirSync(architectureEvidenceDir, { recursive: true });
const reportDir = mkdtempSync(join(architectureEvidenceDir, "duplication-"));
writeFileSync(join(reportDir, "report.txt"), `${report}\n`, { flag: "wx" });
console.log(report.split("\n")[0]);
