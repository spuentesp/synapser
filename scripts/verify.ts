// Plan 18 E1: the single entry point. It runs each level in order and stops at the first failure.
// The binary check reuses the pin verification the runtime itself uses (src/zoo), so the two cannot drift apart.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBinary } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

function run(label: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if (r.status !== 0) {
    console.error(`\n✖ ${label} failed (${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`})`);
    process.exit(r.status ?? 1);
  }
}

async function checkBinary(): Promise<void> {
  console.log("\n▶ binary pin (zoanthrope.lock.json)");
  try {
    const id = await verifyBinary(loadPin());
    console.log(`  ${id.version}${id.sha256 ? ` sha256 ${id.sha256.slice(0, 12)}…` : " (no digest pinned for this platform)"}`);
  } catch (e) {
    console.error(`\n✖ binary pin failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

await checkBinary();
run("typecheck", "npx", ["tsc", "--noEmit"]);
// Plan 18 H12.2 and H12.3: layer rules and cycles.
run("architecture rules", "npx", ["depcruise", "src", "web/src", "test", "--config", ".dependency-cruiser.cjs"]);
// Plan 18 H12.4: report duplicated blocks; no blocking threshold has been agreed.
run("duplication report (informational)", "node", ["scripts/duplication-report.ts"]);
if (existsSync(new URL("test/contract", root))) {
  run("contract tests", "node", ["--test", "--test-reporter=spec", "test/contract/**/*.test.ts"]);
}
run("all tests", "node", ["--test", "--test-reporter=spec", "test/**/*.test.ts"]);
// Plan 18 H4.3: security modules must keep their mutation score above the threshold in stryker.config.json.
// Each verify gets its own report and scratch path; don't overwrite evidence or clean an old Stryker directory.
const runId = `${Date.now()}-${process.pid}`;
const mutationReport = resolve(rootPath, "evidence/mutation", `verify-${runId}.json`);
const mutationTempDir = join(tmpdir(), `synapser-stryker-${runId}`);
mkdirSync(resolve(rootPath, "evidence/mutation"), { recursive: true });
const mutationEnv = {
  ...process.env,
  SYNAPSER_MUTATION_REPORT: mutationReport,
  SYNAPSER_MUTATION_TEMP_DIR: mutationTempDir,
};
run("mutation (security modules)", "npx", ["stryker", "run", "stryker.verify.config.mjs"], mutationEnv);
run("mutation gate (per module)", "node", ["scripts/mutation-gate.ts", mutationReport]);
console.log("\n✔ verify passed");
