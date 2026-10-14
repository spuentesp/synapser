// Plan model and its validation (design §4 Task: "Las dependencias forman un DAG validado").
// A plan is PROPOSED by a model and ACCEPTED by control: nothing here trusts model output.

import { PathRejected, resolveInWorkspace } from "../workspace/paths.ts";
import { type ProfileCard, STEP_KINDS, type StepKind } from "../orchestration/catalog.ts";
import { planCost, route } from "../orchestration/router.ts";

export interface PlanTask {
  id: string;
  objective: string;
  scope: string[];
  criteria: string[];
  /** Shared reference material (e.g. an API contract). Other agents implement the parts outside this task's scope. */
  context?: string[];
  deps: string[];
  priority?: number;
  /** What the step does. Default "write". Non-write steps run with an EMPTY write scope. */
  kind?: StepKind;
  /** The model's SUGGESTION of a profile; the router decides (plan 10 D1). */
  profile?: string;
  /** Gates that must pass before the step starts. Only "approval" exists. */
  gates?: "approval"[];
  /** Capability tags the step asks for (matched against profile strengths). */
  tags?: string[];
  /** Ids of the workflow conditions this task works towards (plan 13 §4.2). */
  serves?: string[];
}
export interface Plan {
  tasks: PlanTask[];
}

export const RESERVED_TASK_IDS = new Set(["validate"]);
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export type PlanCheck = { ok: true; plan: Plan } | { ok: false; errors: string[] };

export interface ValidateOptions {
  workspaceRoot: string;
  maxTasks?: number;
  /** When given, profile suggestions and routability are validated against it. */
  catalog?: readonly ProfileCard[];
  /** When given with a catalog: known + estimated(high) cost may not exceed it. */
  budgetUsd?: number;
  /** Workflow conditions: `serves` must name known ids, and every id in `mustServe` needs ≥1 task. */
  conditions?: { known: ReadonlySet<string>; mustServe: ReadonlySet<string> };
}

export function validatePlan(raw: unknown, opts: ValidateOptions): PlanCheck {
  const errors: string[] = [];
  const max = opts.maxTasks ?? 8;
  const tasksRaw = (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return { ok: false, errors: ["plan.tasks must be a non-empty array"] };
  if (tasksRaw.length > max) errors.push(`plan has ${tasksRaw.length} tasks; at most ${max} allowed`);

  const tasks: PlanTask[] = [];
  const ids = new Set<string>();
  tasksRaw.forEach((t, i) => {
    const at = `tasks[${i}]`;
    const o = t as Record<string, unknown>;
    const id = o?.["id"];
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${at}.id must match ${ID}`);
      return;
    }
    if (RESERVED_TASK_IDS.has(id)) errors.push(`${at}.id "${id}" is reserved`);
    if (ids.has(id)) errors.push(`${at}.id "${id}" is duplicated`);
    ids.add(id);
    const objective = o["objective"];
    if (typeof objective !== "string" || objective.trim().length < 5 || objective.length > 1500) errors.push(`${at}.objective must be a 5..1500 char string`);
    const strArr = (k: string, min: number, maxLen = 600): string[] => {
      const v = o[k];
      if (!Array.isArray(v) || v.length < min || v.some((x) => typeof x !== "string" || x.length === 0 || x.length > maxLen)) {
        const long = Array.isArray(v) && v.some((x) => typeof x === "string" && x.length > maxLen);
        errors.push(`${at}.${k} must be an array of ${min === 0 ? "" : "at least 1 "}non-empty strings of at most ${maxLen} characters${long ? " (an item is too long: split it)" : ""}`);
        return [];
      }
      return v as string[];
    };
    const scope = strArr("scope", 1);
    const criteria = strArr("criteria", 1);
    const deps = o["deps"] === undefined ? [] : strArr("deps", 0);
    // shared reference material (a contract) is legitimately long; it is bounded, not tiny
    const context = o["context"] === undefined ? [] : strArr("context", 0, 6000);
    for (const s of scope) {
      try {
        resolveInWorkspace(opts.workspaceRoot, s.endsWith("/") ? s.slice(0, -1) : s, { requireRegularIfExists: false });
      } catch (e) {
        if (e instanceof PathRejected) errors.push(`${at}.scope "${s}" rejected: ${e.code}`);
        else throw e;
      }
    }
    const priority = typeof o["priority"] === "number" && Number.isInteger(o["priority"]) ? (o["priority"] as number) : 0;

    // orchestration fields (plan 10 §3); all optional, all validated when present
    const task: PlanTask = { id, objective: String(objective ?? ""), scope, criteria, context, deps, priority };
    if (o["kind"] !== undefined) {
      if (typeof o["kind"] === "string" && (STEP_KINDS as readonly string[]).includes(o["kind"])) task.kind = o["kind"] as StepKind;
      else errors.push(`${at}.kind INVALID_KIND: must be one of ${STEP_KINDS.join(", ")}`);
    }
    if (o["profile"] !== undefined) {
      if (typeof o["profile"] === "string" && o["profile"].length > 0 && o["profile"].length <= 80) task.profile = o["profile"];
      else errors.push(`${at}.profile must be a non-empty string`);
    }
    if (o["tags"] !== undefined) {
      if (Array.isArray(o["tags"]) && o["tags"].every((x) => typeof x === "string" && x.length <= 40)) task.tags = o["tags"] as string[];
      else errors.push(`${at}.tags must be an array of short strings`);
    }
    if (o["serves"] !== undefined) {
      if (Array.isArray(o["serves"]) && o["serves"].every((x) => typeof x === "string" && x.length <= 41)) task.serves = o["serves"] as string[];
      else errors.push(`${at}.serves must be an array of condition ids`);
    }
    if (o["gates"] !== undefined) {
      if (Array.isArray(o["gates"]) && o["gates"].every((g) => g === "approval")) task.gates = o["gates"] as "approval"[];
      else errors.push(`${at}.gates INVALID_GATE: only "approval" is supported`);
    }
    if (opts.catalog && task.profile) {
      const card = opts.catalog.find((c) => c.id === task.profile);
      const kind = task.kind ?? "write";
      if (!card) errors.push(`${at}.profile "${task.profile}": PROFILE_UNKNOWN`);
      else if (!card.enabled) errors.push(`${at}.profile "${task.profile}": PROFILE_DISABLED`);
      else if (!card.kinds.includes(kind)) errors.push(`${at}.profile "${task.profile}": PROFILE_KIND_MISMATCH (a ${kind} step needs a profile that can ${kind})`);
    }
    tasks.push(task);
  });

  for (const t of tasks) {
    for (const d of t.deps) {
      if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown task "${d}"`);
      if (d === t.id) errors.push(`task "${t.id}" depends on itself`);
    }
  }
  if (opts.conditions) {
    const served = new Set<string>();
    for (const t of tasks) {
      for (const c of t.serves ?? []) {
        if (!opts.conditions.known.has(c)) errors.push(`task "${t.id}".serves "${c}": UNKNOWN_CONDITION`);
        served.add(c);
      }
    }
    for (const c of opts.conditions.mustServe) if (!served.has(c)) errors.push(`CONDITION_UNSERVED: no task serves condition "${c}"`);
  }
  if (opts.catalog) {
    for (const t of tasks) {
      const d = route({ kind: t.kind ?? "write", suggested: t.profile, ...(t.tags ? { tags: t.tags } : {}) }, opts.catalog);
      if (!d.ok) errors.push(`task "${t.id}": NO_ROUTE (no enabled profile can do a ${t.kind ?? "write"} step)`);
    }
    if (opts.budgetUsd !== undefined && errors.length === 0) {
      const c = planCost(tasks.map((t) => ({ id: t.id, kind: t.kind ?? "write", profile: t.profile, ...(t.tags ? { tags: t.tags } : {}) })), opts.catalog);
      const upper = c.knownUsd + c.estimatedHighUsd;
      if (upper > opts.budgetUsd) errors.push(`OVER_BUDGET: known+estimated upper bound $${upper.toFixed(4)} exceeds the $${opts.budgetUsd.toFixed(4)} limit`);
    }
  }
  if (errors.length === 0) {
    // Kahn: any task left unvisited is on a cycle
    const indeg = new Map(tasks.map((t) => [t.id, t.deps.length]));
    const q = tasks.filter((t) => t.deps.length === 0).map((t) => t.id);
    let seen = 0;
    while (q.length) {
      const n = q.shift() as string;
      seen++;
      for (const t of tasks) {
        if (t.deps.includes(n)) {
          const k = (indeg.get(t.id) as number) - 1;
          indeg.set(t.id, k);
          if (k === 0) q.push(t.id);
        }
      }
    }
    if (seen !== tasks.length) errors.push("dependencies contain a cycle");
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan: { tasks } };
}
