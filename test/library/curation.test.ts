import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { evaluateSkillHoldout, type SkillCase } from "../../src/library/curation.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../curation/fixtures/skill-cases.json");
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as SkillCase[];
const candidate = { id: "review-helper", content: "Call out risks and evidence." };

describe("local skill holdout evaluation (CU1)", () => {
  test("runs every holdout repetition and never exposes dev cases to the executor", async () => {
    const tasks: string[] = [];
    const report = await evaluateSkillHoldout(cases, candidate, ({ task }) => {
      tasks.push(task);
      return task.includes("risk") ? "Risk: missing test." : "Evidence: assertion output.";
    });
    assert.equal(report.eligible, true);
    assert.deepEqual(report.checks.map((check) => check.caseId), ["holdout-risk", "holdout-risk", "holdout-evidence"]);
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((task) => !task.includes("Summarize")));
  });

  test("one failed repetition makes the candidate ineligible and identifies its case and repetition", async () => {
    let attempt = 0;
    const report = await evaluateSkillHoldout(cases, candidate, () => {
      attempt += 1;
      return attempt === 2 ? "No risk identified." : "Risk: missing test.";
    });
    assert.equal(report.eligible, false);
    assert.deepEqual(report.checks.find((check) => !check.passed), {
      caseId: "holdout-risk", repetition: 2, passed: false,
    });
  });

  test("rejects empty holdout sets and malformed split/repetition contracts", async () => {
    await assert.rejects(evaluateSkillHoldout(cases.filter((item) => item.split === "dev"), candidate, () => "Summary:"), /holdout cases are required/);
    await assert.rejects(evaluateSkillHoldout([{ ...cases[1]!, split: "other" as "holdout" }], candidate, () => "Risk:"), /invalid split/);
    await assert.rejects(evaluateSkillHoldout([{ ...cases[1]!, k: 0 }], candidate, () => "Risk:"), /repetition count/);
  });
});
