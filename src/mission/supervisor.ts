// Supervisor (design §1: "un supervisor Nemotron propone tareas y recuperaciones"). It PROPOSES a
// plan as structured JSON; control validates it (DAG, scope containment, size). A rejected plan is
// fed back once with the exact errors; a second failure is an error, not a guess.

import { statSync } from "node:fs";
import { join } from "node:path";
import { listTree } from "../validation/snapshot.ts";
import type { ChatMessage, ModelPort } from "../model/types.ts";
import type { ProfileCard } from "../orchestration/catalog.ts";
import { type Plan, validatePlan } from "./plan.ts";

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          criteria: { type: "array", items: { type: "string" } },
          context: { type: "array", items: { type: "string" } },
          deps: { type: "array", items: { type: "string" } },
          priority: { type: "integer" },
          kind: { type: "string", enum: ["write", "advise", "research", "review"] },
          profile: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          gates: { type: "array", items: { type: "string", enum: ["approval"] } },
        },
        required: ["id", "objective", "scope", "criteria", "deps"],
      },
    },
  },
  required: ["tasks"],
} as const;

const SYSTEM = `You are the planner of a supervised multi-agent coding system. Split the mission into small tasks that different agents can do in parallel.

Rules:
- Output ONLY a JSON object {"tasks":[...]} matching the schema. No prose.
- Each task has: id (lowercase letters, digits, - or _), objective, scope (the ONLY files it may change; use repository-relative paths), criteria (verifiable statements about ITS OWN scope files only), context (shared reference such as the contract; may be empty), deps (ids of tasks that must finish first; [] if none).
- Prefer tasks that touch DIFFERENT files so they can run at the same time. Sharing a file between tasks is allowed when truly needed; the system serializes access.
- Do not create a validation task: the system always adds a final acceptance run.
- Keep every task's scope inside the repository. Never include secrets, .git, or state directories.
- Put the shared contract (names, signatures, formats) into the \`context\` of EVERY task that depends on it, verbatim, so agents agree without talking to each other. Keep each task's \`criteria\` limited to what must be true of the files in ITS scope: agents are told to implement only their own files.`;

/** What the planner may suggest. It sees capabilities and cost BASIS, not secrets or commands. */
export function catalogBlock(catalog: readonly ProfileCard[]): string {
  const rows = catalog
    .filter((c) => c.enabled)
    .map((c) => {
      const cost = c.cost.basis === "unknown" ? "cost unknown" : `${c.cost.basis} ~$${c.cost.usdPerRun.toFixed(3)}/run`;
      return `- ${c.id}: can ${c.kinds.join("/")}; strengths ${c.strengths.join(", ") || "-"}; ${cost}`;
    });
  return [
    "AVAILABLE AGENT PROFILES (you may SUGGEST one per task in `profile`, and tag the task in `tags`; the system makes the final assignment):",
    ...rows,
    "Use kind \"advise\" or \"review\" for steps that only inspect (they cannot change files). Add gates [\"approval\"] only to risky or irreversible steps.",
  ].join("\n");
}

export class PlanError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`supervisor produced no valid plan: ${errors.slice(0, 5).join("; ")}`);
    this.name = "PlanError";
    this.errors = errors;
  }
}

export function repoSummary(workspaceRoot: string, limit = 80): string {
  const files = listTree(workspaceRoot).slice(0, limit);
  return files.map((f) => `${f} (${statSync(join(workspaceRoot, f)).size} bytes)`).join("\n");
}

function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return JSON.parse(fenced ? (fenced[1] as string) : t);
}

export async function planMission(
  model: ModelPort,
  input: { runId: string; objective: string; contract: string[]; workspaceRoot: string; maxTasks?: number; catalog?: readonly ProfileCard[]; budgetUsd?: number },
  ctxExtra: { budget?: import("../model/budget.ts").BudgetManager } = {},
): Promise<{ plan: Plan; attempts: number }> {
  const user = [
    `MISSION: ${input.objective}`,
    `CONTRACT (copy it into every task that needs it):\n${input.contract.map((c) => `- ${c}`).join("\n")}`,
    `REPOSITORY FILES:\n${repoSummary(input.workspaceRoot)}`,
    ...(input.catalog ? [catalogBlock(input.catalog)] : []),
    `Produce at most ${input.maxTasks ?? 5} tasks.`,
  ].join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.complete(
      { role: "supervisor", messages, responseSchema: { name: "plan", schema: PLAN_SCHEMA }, maxTokens: 6000 },
      { runId: input.runId, ...(ctxExtra.budget ? { budget: ctxExtra.budget } : {}) },
    );
    let parsed: unknown;
    try {
      parsed = extractJson(res.content ?? "");
    } catch {
      errors = ["the response was not valid JSON"];
      messages.push(res.assistantMessage, { role: "user", content: `That was not valid JSON. Output ONLY the JSON object.` });
      continue;
    }
    const check = validatePlan(parsed, {
      workspaceRoot: input.workspaceRoot,
      ...(input.maxTasks ? { maxTasks: input.maxTasks } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    });
    if (check.ok) return { plan: check.plan, attempts: attempt };
    errors = check.errors;
    messages.push(res.assistantMessage, { role: "user", content: `The plan was rejected by the validator:\n${check.errors.map((e) => `- ${e}`).join("\n")}\nFix these problems and output ONLY the corrected JSON.` });
  }
  throw new PlanError(errors);
}
