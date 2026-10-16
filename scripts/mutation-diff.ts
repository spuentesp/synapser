// Run the existing module mutation gates selected by a working-tree or base-ref diff.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEvidenceRoot, resolveExternalDirectory } from "./evidence-path.ts";
import { mutationScope, type MutationModule } from "./mutation-scope.ts";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const moduleConfig: Record<MutationModule, string> = {
  security: "scripts/mutation-thresholds.json",
  journal: "scripts/mutation-thresholds.core.json",
  executor: "scripts/mutation-thresholds.executor.json",
  library: "scripts/mutation-thresholds.library.json",
};

function gitPaths(args: string[]): string[] {
  const result = spawnSync("git", args, { cwd: rootPath, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function parseArgs(args: string[]): { base?: string; dryRun: boolean } {
  let base: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--base") {
      base = args[++i];
      if (!base || base.startsWith("--")) throw new Error("--base requires a git ref");
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      if (!base) throw new Error("--base requires a git ref");
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { ...(base ? { base } : {}), dryRun };
}

function changedPaths(base?: string): string[] {
  const committed = base ? gitPaths(["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`]) : [];
  const working = gitPaths(["diff", "--name-only", "--diff-filter=ACDMRT", "HEAD"]);
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...committed, ...working, ...untracked])].sort();
}

function run(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { cwd: rootPath, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const scope = mutationScope(changedPaths(options.base));
  if (scope.uncoveredRuntimeFiles.length > 0) {
    console.error(`✖ runtime files have no mutation gate:\n- ${scope.uncoveredRuntimeFiles.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  if (scope.modules.length === 0) {
    console.log("No changed src/ files select an existing mutation module.");
    return;
  }
  console.log(`Changed source selects: ${scope.modules.join(", ")}`);
  if (options.dryRun) return;

  const evidenceRoot = resolveEvidenceRoot(rootPath, process.env["SYNAPSER_EVIDENCE_DIR"]);
  const runRoot = join(evidenceRoot, "mutation", "diff");
  const incrementalRoot = join(evidenceRoot, "mutation", "incremental");
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(incrementalRoot, { recursive: true });
  const tempRoot = resolveExternalDirectory(rootPath, tmpdir(), "TMPDIR");

  for (const moduleName of scope.modules) {
    const id = randomUUID();
    const reportDir = mkdtempSync(join(runRoot, `${moduleName}-${id}-`));
    const tempDir = mkdtempSync(join(tempRoot, `synapser-stryker-${moduleName}-`));
    const report = resolve(reportDir, "report.json");
    const incremental = resolve(incrementalRoot, `${moduleName}.json`);
    const env = {
      ...process.env,
      SYNAPSER_MUTATION_MODULE: moduleName,
      SYNAPSER_MUTATION_TEMP_DIR: tempDir,
      SYNAPSER_MUTATION_REPORT: report,
      SYNAPSER_MUTATION_INCREMENTAL_FILE: incremental,
    };
    run(`mutation:diff (${moduleName})`, "npx", ["stryker", "run", "stryker.diff.config.mjs"], env);
    run(`mutation gate (${moduleName})`, process.execPath, ["scripts/mutation-gate.ts", report, moduleConfig[moduleName]], process.env);
  }
}

main();
