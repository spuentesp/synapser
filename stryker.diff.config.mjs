// Run one stable module configuration with unique output paths and its own incremental cache.
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const configs = {
  security: "./stryker.config.json",
  journal: "./stryker.core.json",
  executor: "./stryker.executor.json",
  library: "./stryker.library.json",
};
const moduleName = process.env["SYNAPSER_MUTATION_MODULE"];
const basePath = moduleName ? configs[moduleName] : undefined;
const tempDirName = process.env["SYNAPSER_MUTATION_TEMP_DIR"];
const reportFileName = process.env["SYNAPSER_MUTATION_REPORT"];
const incrementalFile = process.env["SYNAPSER_MUTATION_INCREMENTAL_FILE"];

if (!basePath) throw new Error("SYNAPSER_MUTATION_MODULE must name a configured module");
if (![tempDirName, reportFileName, incrementalFile].every((path) => path && isAbsolute(path))) {
  throw new Error("mutation diff must provide absolute, isolated temp, report, and incremental paths");
}

const base = require(basePath);
const ignorePatterns = Array.isArray(base.ignorePatterns) ? base.ignorePatterns : [];
const jsonReporter = base.jsonReporter && typeof base.jsonReporter === "object" ? base.jsonReporter : {};

export default {
  ...base,
  tempDirName,
  cleanTempDir: true,
  incremental: true,
  incrementalFile,
  ignorePatterns: [...new Set([...ignorePatterns, ".env", ".env.*", "**/.env", "**/.env.*", "evidence/**"])],
  jsonReporter: { ...jsonReporter, fileName: reportFileName },
};
