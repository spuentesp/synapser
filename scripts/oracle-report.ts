// Plan 18 H8.5: summarize oracle attempts without changing the append-only evidence log.
import { readFileSync } from "node:fs";

interface OracleAttempt {
  at: string;
  runId: string;
  passed: boolean;
  exitCode: number | null;
}

function isAttempt(value: unknown): value is OracleAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row["at"] === "string"
    && Number.isFinite(Date.parse(row["at"]))
    && typeof row["runId"] === "string"
    && row["runId"].length > 0
    && typeof row["passed"] === "boolean"
    && (row["exitCode"] === null || Number.isInteger(row["exitCode"]));
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: node scripts/oracle-report.ts <oracle-attempts.jsonl>\n");
    process.exitCode = 2;
    return;
  }

  const rows: OracleAttempt[] = [];
  const contents = readFileSync(file, "utf8");
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on line ${index + 1}`);
    }
    if (!isAttempt(value)) throw new Error(`invalid oracle attempt on line ${index + 1}`);
    rows.push(value);
  }

  const runs = new Map<string, { attempts: number; passed: number; failed: number }>();
  for (const row of rows) {
    const summary = runs.get(row.runId) ?? { attempts: 0, passed: 0, failed: 0 };
    summary.attempts++;
    if (row.passed) summary.passed++;
    else summary.failed++;
    runs.set(row.runId, summary);
  }

  const summaries = [...runs].map(([runId, summary]) => ({ runId, ...summary }));
  process.stdout.write(`${JSON.stringify({
    totalAttempts: rows.length,
    runs: summaries,
    repeatedAttempts: summaries.reduce((total, run) => total + Math.max(0, run.attempts - 1), 0),
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
