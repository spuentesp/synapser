import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const fixture = join(root, "test/curation/fixtures/skill-cases.json");
const cli = join(root, "scripts/evaluate-skill-holdout.ts");

function run(outputs: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "synapser-curation-"));
  try {
    const candidate = join(directory, "candidate.json");
    const recorded = join(directory, "outputs.json");
    writeFileSync(candidate, JSON.stringify({ id: "review-helper", content: "Call out risks and evidence." }));
    writeFileSync(recorded, JSON.stringify(outputs));
    return spawnSync(process.execPath, [cli, fixture, candidate, recorded], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("local skill holdout operator CLI (CU1)", () => {
  test("scores exact recorded holdout outputs and emits an advisory report", () => {
    const output = run([
      { caseId: "holdout-risk", repetition: 1, output: "Risk: missing test." },
      { caseId: "holdout-risk", repetition: 2, output: "Risk: missing test." },
      { caseId: "holdout-evidence", repetition: 1, output: "Evidence: assertion output." },
    ]);
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout) as { eligible: boolean; checks: unknown[] };
    assert.equal(report.eligible, true);
    assert.equal(report.checks.length, 3);
  });

  test("rejects missing, duplicate, or unexpected case repetitions", () => {
    const one = { caseId: "holdout-risk", repetition: 1, output: "Risk:" };
    assert.match(run([one]).stderr, /missing output: holdout-risk repetition 2/);
    assert.match(run([one, one]).stderr, /duplicate output/);
    assert.match(run([
      { caseId: "holdout-risk", repetition: 1, output: "Risk:" },
      { caseId: "holdout-risk", repetition: 2, output: "Risk:" },
      { caseId: "holdout-evidence", repetition: 1, output: "Evidence:" },
      { caseId: "dev-summary", repetition: 1, output: "Summary:" },
    ]).stderr, /unexpected output/);
  });

  test("returns nonzero when any recorded output fails the acceptance check", () => {
    const output = run([
      { caseId: "holdout-risk", repetition: 1, output: "Risk: missing test." },
      { caseId: "holdout-risk", repetition: 2, output: "No risk identified." },
      { caseId: "holdout-evidence", repetition: 1, output: "Evidence: assertion output." },
    ]);
    assert.equal(output.status, 1);
    assert.equal((JSON.parse(output.stdout) as { eligible: boolean }).eligible, false);
  });
});
