// Evaluation of acceptance conditions (plan 13 §4.2). Every checker is deterministic EXCEPT `review`,
// whose evidence is labelled secondary. One evaluation round judges ALL conditions and guards against
// the SAME consistent snapshot (C4), and returns one result per condition so a failure says exactly
// which statements are unmet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeFile } from "../digest/file.ts";
import type { Journal } from "../journal/journal.ts";
import { approvalStatus, requestApproval } from "../orchestration/gates.ts";
import { verifyCitations } from "../research/citations.ts";
import type { ValidationPort } from "../validation/runner.ts";
import { listTree, treeDigest } from "../validation/snapshot.ts";
import { type Checker, type Condition, matchesPattern, type Workflow } from "./model.ts";

export type EvidenceKind = "deterministic" | "human" | "secondary";
export type ConditionStatus = "SATISFIED" | "UNSATISFIED" | "WAIVED" | "INFO_OK" | "INFO_FAIL";

export interface ConditionResult {
  /** A condition id, or `guard:<n>` for a non-goal guard. */
  id: string;
  statement: string;
  required: boolean;
  status: ConditionStatus;
  evidence: EvidenceKind;
  detail: string;
  checker: Checker["kind"];
  snapshot: string;
}

export interface CheckerContext {
  journal: Journal;
  runId: string;
  workspaceRoot: string;
  validation: ValidationPort;
  /** The task id under which command validations are recorded. */
  taskId: string;
  /** path → digest at the moment the workflow started RUNNING. */
  baseline: ReadonlyMap<string, string | null>;
  /** Waits for a human decision on a `approval` condition. Resolves "APPROVED" | "REJECTED" | "TIMEOUT". */
  awaitApproval: (key: string, snapshot: string, prompt: string) => Promise<"APPROVED" | "REJECTED" | "TIMEOUT">;
  /**
   * Makes sure an effect has been performed: reuses a finished/in-flight one, or requests it, then waits
   * for the human decision the policy requires. Absent ⇒ effect conditions cannot be satisfied.
   */
  ensureEffect?: (kind: string, params: Record<string, unknown>) => Promise<{ state: string; reason: string | null; evidence: Record<string, unknown> | null; summary: string }>;
  /** Runs a reviewer; absent ⇒ review conditions are unsatisfied with that explanation. */
  review?: (profileId: string, rubric: string) => Promise<{ verdict: "pass" | "fail"; text: string }>;
}

/** Paths whose digest differs from the baseline: added, modified or deleted. */
export function changedPaths(root: string, baseline: ReadonlyMap<string, string | null>): string[] {
  const now = new Map<string, string | null>();
  for (const p of listTree(root)) {
    const o = observeFile(join(root, p));
    now.set(p, o.kind === "file" ? o.digest : null);
  }
  const out = new Set<string>();
  for (const [p, d] of now) if (baseline.get(p) !== d) out.add(p);
  for (const [p, d] of baseline) if (d !== null && !now.has(p)) out.add(p);
  return [...out].sort();
}

export function baselineOf(root: string): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of listTree(root)) {
    const o = observeFile(join(root, p));
    m.set(p, o.kind === "file" ? o.digest : null);
  }
  return m;
}

type Outcome = { ok: boolean; detail: string; evidence: EvidenceKind };

async function run(checker: Checker, id: string, ctx: CheckerContext, snapshot: string): Promise<Outcome> {
  switch (checker.kind) {
    case "command": {
      const v = await ctx.validation.run(checker.commandId, { taskId: ctx.taskId });
      const detail = `${checker.commandId}: exit=${String(v.exitCode)}${v.timedOut ? " (timeout)" : ""}${v.valid ? "" : ` [snapshot invalid: ${v.note}]`}`;
      return { ok: v.passed && v.valid, detail: v.passed ? detail : `${detail}\n${(v.stdout + v.stderr).slice(-1500)}`, evidence: "deterministic" };
    }
    case "citations": {
      let text: string;
      try {
        text = readFileSync(join(ctx.workspaceRoot, checker.file), "utf8");
      } catch {
        return { ok: false, detail: `CITATION_UNVERIFIED: ${checker.file} does not exist`, evidence: "deterministic" };
      }
      const v = verifyCitations(ctx.journal, text, { requireAtLeast: checker.min });
      if (v.ok) return { ok: true, detail: `${v.cited.length} cited, all retrieved in this run`, evidence: "deterministic" };
      return {
        ok: false,
        detail: v.unretrieved.length ? `CITATION_UNVERIFIED: not retrieved by any search of this run: ${v.unretrieved.join(", ")}` : `needs at least ${checker.min} cited URL(s), found ${v.cited.length}`,
        evidence: "deterministic",
      };
    }
    case "diff": {
      const changed = changedPaths(ctx.workspaceRoot, ctx.baseline);
      const missing = (checker.require ?? []).filter((p) => !changed.some((c) => matchesPattern(c, p)));
      const forbidden = changed.filter((c) => (checker.forbid ?? []).some((p) => matchesPattern(c, p)));
      const ok = missing.length === 0 && forbidden.length === 0;
      return {
        ok,
        detail: ok ? `${changed.length} path(s) changed, constraints hold` : [missing.length ? `required change missing: ${missing.join(", ")}` : "", forbidden.length ? `forbidden path(s) changed: ${forbidden.join(", ")}` : ""].filter(Boolean).join("; "),
        evidence: "deterministic",
      };
    }
    case "file": {
      const o = observeFile(join(ctx.workspaceRoot, checker.path));
      if (checker.assert === "exists") return { ok: o.kind === "file", detail: o.kind === "file" ? `${checker.path} exists` : `${checker.path} does not exist`, evidence: "deterministic" };
      if (checker.assert === "absent") return { ok: o.kind === "absent", detail: o.kind === "absent" ? `${checker.path} is absent` : `${checker.path} exists`, evidence: "deterministic" };
      if (o.kind !== "file") return { ok: false, detail: `${checker.path} does not exist`, evidence: "deterministic" };
      const text = readFileSync(join(ctx.workspaceRoot, checker.path), "utf8");
      const ok = text.includes(checker.assert.contains);
      return { ok, detail: ok ? `${checker.path} contains the required text` : `${checker.path} does not contain ${JSON.stringify(checker.assert.contains.slice(0, 80))}`, evidence: "deterministic" };
    }
    case "approval": {
      const d = await ctx.awaitApproval(`cond:${id}`, snapshot, checker.prompt);
      return { ok: d === "APPROVED", detail: d === "APPROVED" ? "approved by a human" : d === "REJECTED" ? "rejected by a human" : "no human decision before the deadline", evidence: "human" };
    }
    case "effect": {
      if (!ctx.ensureEffect) return { ok: false, detail: "effects are not available in this run", evidence: "deterministic" };
      const e = await ctx.ensureEffect(checker.effectKind, checker.params);
      if (e.state === "DONE") return { ok: true, detail: `${checker.effectKind} performed: ${JSON.stringify(e.evidence ?? {}).slice(0, 200)}`, evidence: "human" };
      return { ok: false, detail: `${checker.effectKind} is ${e.state}${e.reason ? `: ${e.reason}` : ""}`, evidence: "human" };
    }
    case "review": {
      if (!ctx.review) return { ok: false, detail: "no reviewer is configured", evidence: "secondary" };
      const r = await ctx.review(checker.profile, checker.rubric);
      return { ok: r.verdict === "pass", detail: `review by ${checker.profile}: ${r.verdict} — ${r.text.slice(0, 300)}`, evidence: "secondary" };
    }
  }
}

/** One round over a consistent snapshot: all conditions, then all non-goal guards. */
export async function evaluateWorkflow(w: Workflow, ctx: CheckerContext): Promise<{ results: ConditionResult[]; snapshot: string; satisfied: boolean }> {
  const snapshot = treeDigest(ctx.workspaceRoot);
  const results: ConditionResult[] = [];
  const push = (id: string, statement: string, required: boolean, checker: Checker, o: Outcome, waived?: Condition["waivedBy"]) => {
    const status: ConditionStatus = waived ? "WAIVED" : o.ok ? (required ? "SATISFIED" : "INFO_OK") : required ? "UNSATISFIED" : "INFO_FAIL";
    results.push({ id, statement, required, status, evidence: o.evidence, detail: waived ? `waived by ${waived.actor}: ${waived.reason}` : o.detail, checker: checker.kind, snapshot });
  };
  // Effects are requested only when EVERYTHING ELSE holds: never publish work that is not accepted.
  const ordered = [...w.conditions.filter((c) => c.checker.kind !== "effect"), ...w.conditions.filter((c) => c.checker.kind === "effect")];
  // ANY unmet required condition blocks the next effect — an earlier rejected commit included
  const blockedBy = (): string[] => results.filter((r) => r.required && r.status === "UNSATISFIED").map((r) => r.id);
  for (const c of ordered) {
    if (c.checker.kind === "effect" && !c.waivedBy) {
      const blockers = blockedBy();
      if (blockers.length) {
        push(c.id, c.statement, c.required, c.checker, { ok: false, detail: `not attempted: required condition(s) unmet (${blockers.join(", ")}), so nothing is published`, evidence: "deterministic" });
        continue;
      }
    }
    if (c.waivedBy) {
      push(c.id, c.statement, c.required, c.checker, { ok: false, detail: "", evidence: "deterministic" }, c.waivedBy);
      continue;
    }
    let o: Outcome;
    try {
      o = await run(c.checker, c.id, ctx, snapshot);
    } catch (e) {
      o = { ok: false, detail: `checker error: ${String((e as Error).message ?? e).slice(0, 200)}`, evidence: "deterministic" };
    }
    // E3: a judgement by an agent never satisfies a REQUIRED condition on its own
    if (o.ok && c.required && o.evidence === "secondary" && !c.secondaryAccepted) {
      o = { ok: false, detail: `${o.detail} — secondary evidence is not accepted for a required condition`, evidence: "secondary" };
    }
    push(c.id, c.statement, c.required, c.checker, o);
  }
  // non-goal guards: violation of a mechanised non-goal blocks DONE exactly like an unmet condition
  for (const [i, g] of w.nonGoals.entries()) {
    if (!g.guard) continue;
    let o: Outcome;
    try {
      o = await run(g.guard, `guard-${i}`, ctx, snapshot);
    } catch (e) {
      o = { ok: false, detail: `guard error: ${String((e as Error).message ?? e).slice(0, 200)}`, evidence: "deterministic" };
    }
    push(`guard:${i}`, `NOT: ${g.statement}`, true, g.guard, o);
  }
  const satisfied = results.every((r) => !r.required || r.status === "SATISFIED" || r.status === "WAIVED");
  return { results, snapshot, satisfied };
}

/** Helper used by the manager: wait for a human on an approval condition, bound to the snapshot. */
export function approvalWaiter(journal: Journal, runId: string, opts: { pollMs: number; deadlineMs: number; aborted: () => boolean }) {
  return async (key: string, snapshot: string, prompt: string): Promise<"APPROVED" | "REJECTED" | "TIMEOUT"> => {
    requestApproval(journal, runId, key, snapshot, prompt);
    for (;;) {
      const st = approvalStatus(journal, key, snapshot);
      if (st === "APPROVED") return "APPROVED";
      if (st === "REJECTED") return "REJECTED";
      if (opts.aborted() || Date.now() > opts.deadlineMs) return "TIMEOUT";
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  };
}
