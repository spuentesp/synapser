// Workflow = a task with a description, goals, non-goals and ACCEPTANCE CONDITIONS; it ends when every
// required condition is satisfied with evidence (plan 13 §4). This module is the data model and its
// validation: pure, no I/O except path containment.

import { PathRejected, resolveInWorkspace } from "../workspace/paths.ts";

export type Checker =
  | { kind: "command"; commandId: string }
  | { kind: "citations"; file: string; min: number }
  | { kind: "diff"; require?: string[]; forbid?: string[] }
  | { kind: "file"; path: string; assert: "exists" | "absent" | { contains: string } }
  | { kind: "approval"; prompt: string }
  | { kind: "review"; profile: string; rubric: string }
  /** Satisfied when Synapser has PERFORMED this effect (after the human decision its policy requires). */
  | { kind: "effect"; effectKind: string; params: Record<string, unknown> };

export type CheckerKind = Checker["kind"];

export interface Condition {
  id: string;
  statement: string;
  checker: Checker;
  /** Informational conditions are evaluated and shown but never block DONE. */
  required: boolean;
  /** An explicit, audited exemption: the condition is not enforced. */
  waivedBy?: { actor: string; reason: string };
  /** A `review` (an agent's judgement) is SECONDARY evidence: it may be required only with this. */
  secondaryAccepted?: { actor: string; reason: string };
}

/** A non-goal and, when it can be mechanised, the guard that detects its violation. */
export interface NonGoal {
  statement: string;
  guard?: Extract<Checker, { kind: "diff" | "file" | "command" }>;
}

export interface Workflow {
  id: string;
  title: string;
  description: string;
  goals: string[];
  nonGoals: NonGoal[];
  conditions: Condition[];
  budget?: { usd?: number; minutes?: number };
}

export const WORKFLOW_STATES = ["DRAFT", "AWAITING_START", "PLANNING", "RUNNING", "VERIFYING", "DONE", "FAILED", "CANCELLED"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export type WorkflowCheck = { ok: true; workflow: Workflow } | { ok: false; errors: string[] };

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const WF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const isStr = (v: unknown, min = 1, max = 2000): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const strList = (v: unknown, max = 40): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => isStr(x, 1, 600));

export interface ValidateWorkflowOptions {
  workspaceRoot: string;
  /** Ids of the allowlisted commands a `command` checker may name. */
  commandIds: ReadonlySet<string>;
  /** Profile ids a `review` checker may name (omit to skip the check). */
  profileIds?: ReadonlySet<string>;
}

function checkChecker(c: unknown, at: string, o: ValidateWorkflowOptions, errors: string[], allowed?: readonly CheckerKind[]): Checker | null {
  const x = c as Record<string, unknown> | null;
  if (!x || typeof x !== "object") {
    errors.push(`${at}.checker must be an object`);
    return null;
  }
  const kind = x["kind"];
  if (typeof kind !== "string") {
    errors.push(`${at}.checker.kind is required`);
    return null;
  }
  if (allowed && !allowed.includes(kind as CheckerKind)) {
    errors.push(`${at}.checker.kind "${kind}" is not allowed here (one of ${allowed.join(", ")})`);
    return null;
  }
  const path = (p: unknown, field: string): string | null => {
    if (!isStr(p, 1, 300)) {
      errors.push(`${at}.checker.${field} must be a path`);
      return null;
    }
    try {
      resolveInWorkspace(o.workspaceRoot, (p as string).replace(/\/$/, ""), { requireRegularIfExists: false });
      return p as string;
    } catch (e) {
      if (e instanceof PathRejected) errors.push(`${at}.checker.${field} "${String(p)}" rejected: ${e.code}`);
      else throw e;
      return null;
    }
  };
  switch (kind) {
    case "command":
      if (!isStr(x["commandId"], 1, 80) || !o.commandIds.has(x["commandId"] as string)) {
        errors.push(`${at}.checker.commandId "${String(x["commandId"])}" is not an allowlisted command (${[...o.commandIds].join(", ") || "none configured"})`);
        return null;
      }
      return { kind: "command", commandId: x["commandId"] as string };
    case "citations": {
      const file = path(x["file"], "file");
      const min = x["min"] === undefined ? 1 : x["min"];
      if (typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > 50) {
        errors.push(`${at}.checker.min must be an integer 1..50`);
        return null;
      }
      return file ? { kind: "citations", file, min } : null;
    }
    case "diff": {
      const require = x["require"] === undefined ? [] : x["require"];
      const forbid = x["forbid"] === undefined ? [] : x["forbid"];
      if (!strList(require) || !strList(forbid)) {
        errors.push(`${at}.checker.require/forbid must be arrays of path patterns`);
        return null;
      }
      if (require.length + forbid.length === 0) {
        errors.push(`${at}.checker.diff needs at least one require or forbid pattern`);
        return null;
      }
      return { kind: "diff", ...(require.length ? { require } : {}), ...(forbid.length ? { forbid } : {}) };
    }
    case "file": {
      const p = path(x["path"], "path");
      const a = x["assert"];
      const ok = a === "exists" || a === "absent" || (typeof a === "object" && a !== null && isStr((a as { contains?: unknown }).contains, 1, 500));
      if (!ok) {
        errors.push(`${at}.checker.assert must be "exists", "absent" or {contains}`);
        return null;
      }
      return p ? { kind: "file", path: p, assert: a as never } : null;
    }
    case "approval":
      if (!isStr(x["prompt"], 3, 500)) {
        errors.push(`${at}.checker.prompt must be a 3..500 char string`);
        return null;
      }
      return { kind: "approval", prompt: x["prompt"] as string };
    case "review":
      if (!isStr(x["profile"], 1, 80) || !isStr(x["rubric"], 3, 1000)) {
        errors.push(`${at}.checker.profile and .rubric are required`);
        return null;
      }
      if (o.profileIds && !o.profileIds.has(x["profile"] as string)) {
        errors.push(`${at}.checker.profile "${String(x["profile"])}" is not a known profile`);
        return null;
      }
      return { kind: "review", profile: x["profile"] as string, rubric: x["rubric"] as string };
    case "effect": {
      const ek = x["effectKind"];
      const pr = x["params"];
      if (!isStr(ek, 3, 40) || !/^[a-z][a-z0-9_.]*$/.test(ek as string)) {
        errors.push(`${at}.checker.effectKind must be an effect kind such as git.push`);
        return null;
      }
      if (!pr || typeof pr !== "object" || Array.isArray(pr)) {
        errors.push(`${at}.checker.params must be an object`);
        return null;
      }
      return { kind: "effect", effectKind: ek as string, params: pr as Record<string, unknown> };
    }
    default:
      errors.push(`${at}.checker.kind "${kind}" is unknown`);
      return null;
  }
}

export function validateWorkflow(raw: unknown, o: ValidateWorkflowOptions): WorkflowCheck {
  const errors: string[] = [];
  const w = raw as Record<string, unknown> | null;
  if (!w || typeof w !== "object") return { ok: false, errors: ["workflow must be an object"] };

  const id = w["id"];
  if (!isStr(id, 1, 81) || !WF_ID.test(id as string)) errors.push("id must match [A-Za-z0-9][A-Za-z0-9._-]{0,80}");
  if (!isStr(w["title"], 3, 160)) errors.push("title must be a 3..160 char string");
  if (!isStr(w["description"], 10, 4000)) errors.push("description must be a 10..4000 char string");
  const goals = w["goals"] === undefined ? [] : w["goals"];
  if (!strList(goals)) errors.push("goals must be an array of non-empty strings");

  const nonGoals: NonGoal[] = [];
  const rawNG = w["nonGoals"] === undefined ? [] : w["nonGoals"];
  if (!Array.isArray(rawNG) || rawNG.length > 40) errors.push("nonGoals must be an array (at most 40)");
  else {
    rawNG.forEach((g, i) => {
      if (typeof g === "string") {
        if (isStr(g, 1, 600)) nonGoals.push({ statement: g });
        else errors.push(`nonGoals[${i}] must be a non-empty string`);
        return;
      }
      const ng = g as { statement?: unknown; guard?: unknown };
      if (!ng || !isStr(ng.statement, 1, 600)) {
        errors.push(`nonGoals[${i}].statement is required`);
        return;
      }
      if (ng.guard === undefined) nonGoals.push({ statement: ng.statement });
      else {
        const guard = checkChecker(ng.guard, `nonGoals[${i}].guard`, o, errors, ["diff", "file", "command"]);
        if (guard) nonGoals.push({ statement: ng.statement, guard: guard as NonGoal["guard"] & object });
      }
    });
  }

  const conditions: Condition[] = [];
  const rawC = w["conditions"];
  if (!Array.isArray(rawC) || rawC.length === 0) errors.push("conditions must be a non-empty array: a workflow with nothing to satisfy can never be DONE");
  else if (rawC.length > 30) errors.push("conditions: at most 30");
  else {
    const seen = new Set<string>();
    rawC.forEach((c, i) => {
      const at = `conditions[${i}]`;
      const x = c as Record<string, unknown> | null;
      if (!x || typeof x !== "object") return void errors.push(`${at} must be an object`);
      const cid = x["id"];
      if (!isStr(cid, 1, 41) || !ID.test(cid as string)) errors.push(`${at}.id must match ${ID}`);
      else if (seen.has(cid as string)) errors.push(`${at}.id "${String(cid)}" is duplicated`);
      else seen.add(cid as string);
      if (!isStr(x["statement"], 3, 500)) errors.push(`${at}.statement must be a 3..500 char string`);
      const required = x["required"] === undefined ? true : x["required"];
      if (typeof required !== "boolean") errors.push(`${at}.required must be a boolean`);
      const checker = checkChecker(x["checker"], at, o, errors);
      const person = (v: unknown, field: string) => {
        if (v === undefined) return undefined;
        const p = v as { actor?: unknown; reason?: unknown };
        if (!p || !isStr(p.actor, 1, 80) || !isStr(p.reason, 3, 300)) {
          errors.push(`${at}.${field} needs an actor and a reason`);
          return undefined;
        }
        return { actor: p.actor as string, reason: p.reason as string };
      };
      const waivedBy = person(x["waivedBy"], "waivedBy");
      const secondaryAccepted = person(x["secondaryAccepted"], "secondaryAccepted");
      if (checker?.kind === "review" && required === true && !secondaryAccepted && !waivedBy) {
        errors.push(`${at}: a "review" is an agent's judgement (secondary evidence) and cannot make a REQUIRED condition pass by itself: set required=false, or record secondaryAccepted {actor, reason}`);
      }
      if (checker && isStr(cid) && isStr(x["statement"]) && typeof required === "boolean") {
        conditions.push({
          id: cid as string, statement: x["statement"] as string, checker, required,
          ...(waivedBy ? { waivedBy } : {}), ...(secondaryAccepted ? { secondaryAccepted } : {}),
        });
      }
    });
    if (conditions.length > 0 && !conditions.some((c) => c.required && !c.waivedBy) && errors.length === 0) {
      errors.push("at least one condition must be required and not waived: otherwise DONE would mean nothing");
    }
  }

  let budget: Workflow["budget"];
  if (w["budget"] !== undefined) {
    const b = w["budget"] as { usd?: unknown; minutes?: unknown };
    if (!b || typeof b !== "object" || (b.usd !== undefined && (typeof b.usd !== "number" || b.usd <= 0)) || (b.minutes !== undefined && (typeof b.minutes !== "number" || b.minutes <= 0))) {
      errors.push("budget.usd and budget.minutes must be positive numbers");
    } else budget = { ...(b.usd !== undefined ? { usd: b.usd as number } : {}), ...(b.minutes !== undefined ? { minutes: b.minutes as number } : {}) };
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    workflow: {
      id: id as string, title: w["title"] as string, description: w["description"] as string, goals: goals as string[], nonGoals, conditions,
      ...(budget ? { budget } : {}),
    },
  };
}

/** Path patterns for diff guards: exact, `dir/` prefix, `*` within a segment, `**` across segments. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!/[*?]/.test(pattern)) return path === pattern;
  const re = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}
