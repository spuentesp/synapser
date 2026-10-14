// The advisor's vocabulary (plan 13 §6). Nemotron PROPOSES typed interventions; control validates and
// applies them. Nothing here is free text that becomes an action: an intervention is a closed set of
// shapes, each checked against the live state of the workflow before it can have any effect.

export const INTERVENTION_TYPES = ["inject_note", "hold", "escalate", "replan", "rollback", "pushback"] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export interface Finding {
  claim: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
  /** URLs a search of THIS run returned (P1: a finding without a retrieved source is not emitted). */
  sources: string[];
}

export type Intervention =
  | { type: "inject_note"; task: string; text: string; why: string }
  | { type: "hold"; task: string; reason: string; why: string }
  | { type: "escalate"; task: string; reason: string; why: string }
  | { type: "replan"; task: string; split: { objective: string; scope: string[]; criteria: string[] }[]; why: string }
  | { type: "rollback"; task: string; why: string }
  | { type: "pushback"; task: string; findings: Finding[]; why: string };

export type InterventionState = "PROPOSED" | "AWAITING_APPROVAL" | "APPLIED" | "REJECTED" | "FAILED";

export interface InterventionRecord {
  id: string;
  type: InterventionType;
  task: string;
  state: InterventionState;
  body: Intervention;
  trigger: string;
  evidence: number[];
  reason: string | null;
  seq: number;
}

/** What the model must answer: strict JSON, nothing else. */
export const ADVISOR_SCHEMA = {
  type: "object",
  properties: {
    assessment: { type: "string" },
    interventions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...INTERVENTION_TYPES] },
          task: { type: "string" },
          text: { type: "string" },
          reason: { type: "string" },
          why: { type: "string" },
          split: {
            type: "array",
            items: {
              type: "object",
              properties: { objective: { type: "string" }, scope: { type: "array", items: { type: "string" } }, criteria: { type: "array", items: { type: "string" } } },
              required: ["objective", "scope", "criteria"],
            },
          },
        },
        required: ["type", "task", "why"],
      },
    },
  },
  required: ["assessment", "interventions"],
} as const;

export interface TaskView {
  taskId: string;
  state: string;
  scope: string[];
  objective: string;
  appliedActions: number;
}

export type ValidationResult = { ok: true; intervention: Intervention } | { ok: false; code: string; detail: string };

const str = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;

/**
 * Check a model-proposed intervention against the LIVE tasks. Anything that does not fit is refused with
 * a code (A2): unknown task, terminal task, text too long, rollback with nothing to revert, scope escape.
 */
export function validateIntervention(raw: unknown, tasks: readonly TaskView[], limits = { maxNote: 800, maxSplit: 4 }): ValidationResult {
  const x = raw as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return { ok: false, code: "NOT_AN_OBJECT", detail: "an intervention must be an object" };
  const type = x["type"];
  if (!(INTERVENTION_TYPES as readonly unknown[]).includes(type)) return { ok: false, code: "UNKNOWN_TYPE", detail: `type must be one of ${INTERVENTION_TYPES.join(", ")}` };
  const task = tasks.find((t) => t.taskId === x["task"]);
  if (!task) return { ok: false, code: "UNKNOWN_TASK", detail: `no task "${String(x["task"])}"` };
  if (!str(x["why"], 3, 500)) return { ok: false, code: "NO_WHY", detail: "every intervention needs a short reason (3..500 chars)" };
  const why = x["why"] as string;
  const live = !["DONE", "FAILED", "CANCELLED"].includes(task.state);

  switch (type as (typeof INTERVENTION_TYPES)[number]) {
    case "inject_note":
      if (!str(x["text"], 3, limits.maxNote)) return { ok: false, code: "BAD_NOTE", detail: `text must be 3..${limits.maxNote} chars` };
      if (task.state === "DONE") return { ok: false, code: "TASK_FINISHED", detail: "the task is already done" };
      return { ok: true, intervention: { type: "inject_note", task: task.taskId, text: x["text"] as string, why } };
    case "hold":
      if (!live) return { ok: false, code: "TASK_FINISHED", detail: `the task is ${task.state}` };
      if (!str(x["reason"] ?? x["text"], 3, 300)) return { ok: false, code: "BAD_REASON", detail: "reason must be 3..300 chars" };
      return { ok: true, intervention: { type: "hold", task: task.taskId, reason: String(x["reason"] ?? x["text"]), why } };
    case "escalate":
      if (task.state === "DONE") return { ok: false, code: "TASK_FINISHED", detail: "the task is already done" };
      return { ok: true, intervention: { type: "escalate", task: task.taskId, reason: String(x["reason"] ?? x["text"] ?? why).slice(0, 300), why } };
    case "replan": {
      const split = x["split"];
      if (!Array.isArray(split) || split.length < 1 || split.length > limits.maxSplit) return { ok: false, code: "BAD_SPLIT", detail: `split must have 1..${limits.maxSplit} subtasks` };
      const inScope = (p: string) => task.scope.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s));
      const out: { objective: string; scope: string[]; criteria: string[] }[] = [];
      for (const [i, sp] of split.entries()) {
        const s = sp as { objective?: unknown; scope?: unknown; criteria?: unknown };
        if (!str(s.objective, 5, 600) || !Array.isArray(s.scope) || s.scope.length === 0 || !Array.isArray(s.criteria) || s.criteria.length === 0) return { ok: false, code: "BAD_SPLIT", detail: `split[${i}] needs objective, scope and criteria` };
        const bad = (s.scope as unknown[]).find((p) => typeof p !== "string" || !inScope(p));
        if (bad !== undefined) return { ok: false, code: "SCOPE_ESCAPE", detail: `split[${i}] scope "${String(bad)}" is outside the original task's scope` };
        out.push({ objective: s.objective as string, scope: s.scope as string[], criteria: (s.criteria as unknown[]).map(String) });
      }
      if (task.state === "DONE") return { ok: false, code: "TASK_FINISHED", detail: "the task is already done" };
      return { ok: true, intervention: { type: "replan", task: task.taskId, split: out, why } };
    }
    case "rollback":
      if (task.appliedActions === 0) return { ok: false, code: "NOTHING_TO_REVERT", detail: "the task applied no changes" };
      return { ok: true, intervention: { type: "rollback", task: task.taskId, why } };
    case "pushback": {
      const f = x["findings"];
      if (!Array.isArray(f) || f.length === 0) return { ok: false, code: "NO_FINDINGS", detail: "a pushback needs findings with sources" };
      return { ok: true, intervention: { type: "pushback", task: task.taskId, findings: f as Finding[], why } };
    }
  }
}
