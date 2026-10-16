// Safe verify-only overlay: preserve the security mutators and thresholds, but isolate each run's output.
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const base = require("./stryker.config.json");
const tempDirName = process.env.SYNAPSER_MUTATION_TEMP_DIR;
const reportFileName = process.env.SYNAPSER_MUTATION_REPORT;

if (!tempDirName || !isAbsolute(tempDirName) || !reportFileName || !isAbsolute(reportFileName)) {
  throw new Error("verify must provide absolute, run-specific mutation temp and report paths");
}

const ignorePatterns = Array.isArray(base.ignorePatterns) ? base.ignorePatterns : [];
const jsonReporter = base.jsonReporter && typeof base.jsonReporter === "object" ? base.jsonReporter : {};

export default {
  ...base,
  tempDirName,
  cleanTempDir: true,
  // The Stryker sandbox does not need operator credentials from ignored env files.
  ignorePatterns: [...new Set([...ignorePatterns, ".env", ".env.*", "**/.env", "**/.env.*"])],
  jsonReporter: { ...jsonReporter, fileName: reportFileName },
};
