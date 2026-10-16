/** Local-only holdout evaluation. This module is intentionally not imported by runtime entry points. */

export interface SkillCase {
  id: string;
  split: "dev" | "holdout";
  task: string;
  k: number;
  expectedIncludes: string;
}

export interface SkillCandidate {
  id: string;
  content: string;
}

export interface HoldoutCheck {
  caseId: string;
  repetition: number;
  passed: boolean;
}

export interface HoldoutReport {
  candidateId: string;
  eligible: boolean;
  checks: HoldoutCheck[];
}

export type SkillCaseExecutor = (input: {
  caseId: string;
  repetition: number;
  task: string;
  skillContent: string;
}) => Promise<string> | string;

/**
 * Run only holdout cases, keeping their expected values away from the candidate executor.
 * Eligibility is advisory: callers must not persist a candidate automatically.
 */
export async function evaluateSkillCases(
  cases: readonly SkillCase[],
  candidate: SkillCandidate,
  split: "dev" | "holdout",
  execute: SkillCaseExecutor,
): Promise<HoldoutReport> {
  if (!candidate.id.trim() || !candidate.content.trim()) throw new Error("candidate id and content are required");
  if (typeof execute !== "function") throw new Error("case executor is required");
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id.trim() || ids.has(item.id)) throw new Error(`invalid or duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (item.split !== "dev" && item.split !== "holdout") throw new Error(`invalid split for case ${item.id}`);
    if (!item.task.trim() || !item.expectedIncludes || !Number.isInteger(item.k) || item.k < 1) {
      throw new Error(`invalid task, check, or repetition count for case ${item.id}`);
    }
  }
  const selected = cases.filter((item) => item.split === split);
  if (selected.length === 0) throw new Error(`${split} cases are required`);

  const checks: HoldoutCheck[] = [];
  for (const item of selected) {
    for (let repetition = 1; repetition <= item.k; repetition += 1) {
      const output = await execute({ caseId: item.id, repetition, task: item.task, skillContent: candidate.content });
      checks.push({ caseId: item.id, repetition, passed: output.includes(item.expectedIncludes) });
    }
  }
  return { candidateId: candidate.id, eligible: checks.every((check) => check.passed), checks };
}

/** Holdout wrapper kept for the local operator CLI (plan 16.4). */
export function evaluateSkillHoldout(cases: readonly SkillCase[], candidate: SkillCandidate, execute: SkillCaseExecutor): Promise<HoldoutReport> {
  return evaluateSkillCases(cases, candidate, "holdout", execute);
}
