// Plan model and its validation (design §4 Task: "Las dependencias forman un DAG validado").
// A plan is PROPOSED by a model and ACCEPTED by control: nothing here trusts model output.

import { PathRejected, resolveInWorkspace } from "../workspace/paths.ts";

export interface PlanTask {
  id: string;
  objective: string;
  scope: string[];
  criteria: string[];
  /** Shared reference material (e.g. an API contract). Other agents implement the parts outside this task's scope. */
  context?: string[];
  deps: string[];
  priority?: number;
}
export interface Plan {
  tasks: PlanTask[];
}

export const RESERVED_TASK_IDS = new Set(["validate"]);
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export type PlanCheck = { ok: true; plan: Plan } | { ok: false; errors: string[] };

export function validatePlan(raw: unknown, opts: { workspaceRoot: string; maxTasks?: number }): PlanCheck {
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
    tasks.push({ id, objective: String(objective ?? ""), scope, criteria, context, deps, priority });
  });

  for (const t of tasks) {
    for (const d of t.deps) {
      if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown task "${d}"`);
      if (d === t.id) errors.push(`task "${t.id}" depends on itself`);
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
