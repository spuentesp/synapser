// Plan 18 E4 (H4.3): a per-module mutation gate. Each security module has its own floor in
// scripts/mutation-thresholds.json. A floor is raised as survivors are killed; it is never lowered to make a run pass.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Arguments (optional): the report and the floors. Defaults: the security modules (verify); the library validator uses its own pair.
const reportPath = resolve(process.argv[2] ?? "evidence/mutation/report.json");
const floors = JSON.parse(readFileSync(resolve(process.argv[3] ?? "scripts/mutation-thresholds.json"), "utf8")) as Record<string, number>;

if (!existsSync(reportPath)) {
  console.error("✖ no mutation report: run npx stryker run first");
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8")) as { files: Record<string, { mutants: { status: string }[] }> };

let failed = false;
for (const [file, floor] of Object.entries(floors)) {
  const mutants = report.files[file]?.mutants;
  if (!mutants) {
    console.error(`✖ ${file}: not in the mutation report`);
    failed = true;
    continue;
  }
  const count = (s: string) => mutants.filter((m) => m.status === s).length;
  const detected = count("Killed") + count("Timeout");
  const valid = detected + count("Survived") + count("NoCoverage");
  const score = valid === 0 ? 100 : (100 * detected) / valid;
  const ok = score >= floor;
  console.log(`${ok ? "✔" : "✖"} ${file}: ${score.toFixed(2)} % (floor ${floor} %)`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
