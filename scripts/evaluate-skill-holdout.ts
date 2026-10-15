import { readFileSync } from "node:fs";
import { evaluateSkillHoldout, type HoldoutCheck, type SkillCandidate, type SkillCase } from "../src/library/curation.ts";

interface RecordedOutput {
  caseId: string;
  repetition: number;
  output: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usage(): never {
  throw new Error("usage: node scripts/evaluate-skill-holdout.ts <cases.json> <candidate.json> <outputs.json>");
}

function validateOutputs(outputs: RecordedOutput[]): Map<string, string> {
  if (!Array.isArray(outputs)) throw new Error("outputs must be a JSON array");
  const indexed = new Map<string, string>();
  for (const item of outputs) {
    if (!item || typeof item.caseId !== "string" || !Number.isInteger(item.repetition) || item.repetition < 1 || typeof item.output !== "string") {
      throw new Error("each output needs caseId, positive repetition, and string output");
    }
    const key = `${item.caseId}\u0000${item.repetition}`;
    if (indexed.has(key)) throw new Error(`duplicate output: ${item.caseId} repetition ${item.repetition}`);
    indexed.set(key, item.output);
  }
  return indexed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) usage();
  const [casesPath, candidatePath, outputsPath] = args as [string, string, string];
  const cases = readJson<SkillCase[]>(casesPath);
  const candidate = readJson<SkillCandidate>(candidatePath);
  const outputs = validateOutputs(readJson<RecordedOutput[]>(outputsPath));
  const report = await evaluateSkillHoldout(cases, candidate, ({ caseId, repetition }) => {
    const key = `${caseId}\u0000${repetition}`;
    if (!outputs.has(key)) throw new Error(`missing output: ${caseId} repetition ${repetition}`);
    const output = outputs.get(key)!;
    outputs.delete(key);
    return output;
  });
  if (outputs.size) throw new Error(`unexpected output: ${outputs.keys().next().value?.replace("\u0000", " repetition ")}`);
  const checks: HoldoutCheck[] = report.checks;
  process.stdout.write(`${JSON.stringify({ ...report, checks }, null, 2)}\n`);
  if (!report.eligible) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "holdout evaluation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
