// The shapes of the library documents this layer owns: agents and skills (plan 16, P16.3). zod decides what each field is
// and which fields a variant requires, so none of that is kept in tables a second time. Agent schemas reject unknown keys;
// the skill schema keeps the legacy behavior of ignoring them. What
// a document may do stays in validate.ts, with the rules that need the operator's file: the profiles an agent may extend,
// the pools, the providers and their models, the key names and the destinations. Providers are not here: their validator is
// shared with the operator's file. Workflow drafts are not here either: their validator mixes shape with references to
// commands, profiles and workspace paths, and it moves in its own step (P16.6).

import { z } from "zod";
import { TIERS, type Tier } from "../agents/profile.ts";

/** The longest timeout a library agent may set (plan 15, IC1). */
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;
/** The largest content of a skill, in bytes (decision D6, plan 14 Q5.4). */
export const MAX_SKILL_BYTES = 64 * 1024;

const tier = z.enum(TIERS as [Tier, ...Tier[]]);
const timeoutMs = z.number().gt(0).lte(MAX_TIMEOUT_MS);
const temperature = z.number().gte(0).lte(2);
const nonBlank = (s: string): boolean => s.trim().length > 0;

/** Case (a): an agent that extends a profile. Only these keys; each may be left out, and the base keeps its own value. */
export const extendingAgentSchema = z.strictObject({
  id: z.unknown().optional(),
  extends: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tier: tier.optional(),
  timeoutMs: timeoutMs.optional(),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  temperature: temperature.optional(),
});

/** Case (b): a native agent of its own. It runs no command, so it has no argv, env, home or permissions. A key without
 *  `.optional()` is required of this variant. */
export const nativeAgentSchema = z.strictObject({
  id: z.unknown().optional(),
  adapter: z.literal("native"),
  role: z.enum(["writer", "advisor"]),
  nativeRole: z.enum(["worker", "repair"]).optional(),
  description: z.string(),
  tags: z.array(z.string()),
  tier: tier.optional(),
  timeoutMs: timeoutMs,
  enabled: z.boolean().optional(),
  model: z.string(),
  provider: z.string(),
  temperature: temperature.optional(),
});

/** A skill: name, description and content are required, tags are optional. Other keys are not refused. */
export const skillSchema = z.object({
  name: z.string().refine(nonBlank),
  description: z.string(),
  content: z.string().refine(nonBlank),
  tags: z.array(z.string()).optional(),
});

const recipeName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const recipeText = z.string().refine(nonBlank);
const recipeMcpTool = z.strictObject({ serverId: recipeName, toolName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) });

const recipeConditionChecker = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("command"), commandId: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal("citations"), file: z.string().min(1).max(300), min: z.number().int().min(1).max(50) }),
  z.strictObject({ kind: z.literal("diff"), require: z.array(recipeText).max(40).optional(), forbid: z.array(recipeText).max(40).optional() }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1).max(300), assert: z.union([z.literal("exists"), z.literal("absent"), z.strictObject({ contains: z.string().min(1).max(500) })]) }),
  z.strictObject({ kind: z.literal("approval"), prompt: z.string().min(3).max(500) }),
  z.strictObject({ kind: z.literal("review"), profile: z.string().min(1).max(80), rubric: z.string().min(3).max(1000) }),
  z.strictObject({ kind: z.literal("effect"), effectKind: z.string().regex(/^[a-z][a-z0-9_.]{2,39}$/), params: z.record(z.string(), z.unknown()) }),
]);

const recipeGuard = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("command"), commandId: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal("diff"), require: z.array(recipeText).max(40).optional(), forbid: z.array(recipeText).max(40).optional() }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1).max(300), assert: z.union([z.literal("exists"), z.literal("absent"), z.strictObject({ contains: z.string().min(1).max(500) })]) }),
]);

const recipeParameter = z.discriminatedUnion("type", [
  z.strictObject({ name: recipeName, type: z.literal("string"), description: recipeText, required: z.boolean(), default: z.string().optional(), maxLength: z.number().int().positive().max(4000).optional() }),
  z.strictObject({ name: recipeName, type: z.literal("string_list"), description: recipeText, required: z.boolean(), default: z.array(z.string()).optional(), maxItems: z.number().int().positive().max(40).optional() }),
  z.strictObject({ name: recipeName, type: z.literal("integer"), description: recipeText, required: z.boolean(), default: z.number().int().optional(), minimum: z.number().int().optional(), maximum: z.number().int().optional() }),
  z.strictObject({ name: recipeName, type: z.literal("boolean"), description: recipeText, required: z.boolean(), default: z.boolean().optional() }),
  z.strictObject({ name: recipeName, type: z.literal("enum"), description: recipeText, required: z.boolean(), options: z.array(recipeText).min(1).max(40), default: z.string().optional() }),
]);

const recipeNonGoal = z.union([
  recipeText,
  z.strictObject({ statement: recipeText, guard: recipeGuard.optional() }),
]);
const recipeCondition = z.strictObject({
  id: recipeName,
  statement: z.string().min(3).max(500),
  checker: recipeConditionChecker,
  required: z.boolean().optional(),
});

/** A reusable task recipe. Workflow instances add their own id and runtime decisions. */
export const taskRecipeSchema = z.strictObject({
  id: z.unknown().optional(),
  schemaVersion: z.literal(1),
  title: z.string().min(3).max(160).refine(nonBlank),
  description: z.string().min(10).max(2000).refine(nonBlank),
  category: z.enum(["review", "adversarial_review", "alternatives", "research", "implementation"]),
  parameters: z.array(recipeParameter).max(32),
  requiredCapabilities: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)).max(16),
  requiredSkills: z.array(z.strictObject({ id: recipeName, required: z.boolean() })).max(8),
  requiredMcpServers: z.array(recipeName).max(16),
  requiredMcpTools: z.array(recipeMcpTool).max(64).optional(),
  workflow: z.strictObject({
    title: z.string().min(3).max(160).refine(nonBlank),
    description: z.string().min(10).max(4000).refine(nonBlank),
    goals: z.array(recipeText).max(40),
    nonGoals: z.array(recipeNonGoal).max(40),
    conditions: z.array(recipeCondition).min(1).max(30),
    budget: z.strictObject({ usd: z.number().positive().optional(), minutes: z.number().positive().optional() }).optional(),
  }),
  startPolicy: z.enum(["draft", "auto_start_bounded", "human_approval"]),
}).superRefine((recipe, ctx) => {
  const parameterNames = new Set<string>();
  recipe.parameters.forEach((parameter, index) => {
    if (parameterNames.has(parameter.name)) ctx.addIssue({ code: "custom", path: ["parameters", index, "name"], message: `duplicate parameter ${parameter.name}` });
    parameterNames.add(parameter.name);
    if (parameter.type === "integer" && parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum) {
      ctx.addIssue({ code: "custom", path: ["parameters", index, "maximum"], message: "maximum must be greater than or equal to minimum" });
    }
    if (parameter.type === "integer" && parameter.default !== undefined
      && ((parameter.minimum !== undefined && parameter.default < parameter.minimum) || (parameter.maximum !== undefined && parameter.default > parameter.maximum))) {
      ctx.addIssue({ code: "custom", path: ["parameters", index, "default"], message: "default must fall within the declared bounds" });
    }
    if (parameter.type === "enum" && parameter.default !== undefined && !parameter.options.includes(parameter.default)) {
      ctx.addIssue({ code: "custom", path: ["parameters", index, "default"], message: "default must be one of the declared options" });
    }
    if (parameter.type === "enum" && new Set(parameter.options).size !== parameter.options.length) {
      ctx.addIssue({ code: "custom", path: ["parameters", index, "options"], message: "options must be unique" });
    }
  });
  if (new Set(recipe.requiredCapabilities).size !== recipe.requiredCapabilities.length) {
    ctx.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "capabilities must be unique" });
  }
  const skillIds = new Set<string>();
  recipe.requiredSkills.forEach((skill, index) => {
    if (skillIds.has(skill.id)) ctx.addIssue({ code: "custom", path: ["requiredSkills", index, "id"], message: `duplicate skill ${skill.id}` });
    skillIds.add(skill.id);
  });
  if (new Set(recipe.requiredMcpServers).size !== recipe.requiredMcpServers.length) {
    ctx.addIssue({ code: "custom", path: ["requiredMcpServers"], message: "MCP server ids must be unique" });
  }
  const requiredServers = new Set(recipe.requiredMcpServers);
  const requiredTools = recipe.requiredMcpTools ?? [];
  const toolKeys = new Set<string>();
  requiredTools.forEach((tool, index) => {
    const key = `${tool.serverId}\0${tool.toolName}`;
    if (toolKeys.has(key)) ctx.addIssue({ code: "custom", path: ["requiredMcpTools", index], message: "MCP tool selections must be unique" });
    toolKeys.add(key);
    if (!requiredServers.has(tool.serverId)) ctx.addIssue({ code: "custom", path: ["requiredMcpTools", index, "serverId"], message: "selected tool server must also be listed in requiredMcpServers" });
  });
  if (requiredServers.size > 0 && requiredServers.size !== new Set(requiredTools.map((tool) => tool.serverId)).size) {
    ctx.addIssue({ code: "custom", path: ["requiredMcpTools"], message: "every required MCP server needs an explicit tool selection" });
  }
  if (recipe.workflow.budget && recipe.workflow.budget.usd === undefined && recipe.workflow.budget.minutes === undefined) {
    ctx.addIssue({ code: "custom", path: ["workflow", "budget"], message: "budget must set usd or minutes" });
  }
  const conditionIds = new Set<string>();
  recipe.workflow.conditions.forEach((condition, index) => {
    if (conditionIds.has(condition.id)) ctx.addIssue({ code: "custom", path: ["workflow", "conditions", index, "id"], message: `duplicate condition ${condition.id}` });
    conditionIds.add(condition.id);
    if (condition.checker.kind === "diff" && (condition.checker.require?.length ?? 0) + (condition.checker.forbid?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["workflow", "conditions", index, "checker"], message: "diff checker needs at least one require or forbid pattern" });
    }
    if (condition.checker.kind === "review" && condition.required !== false) {
      ctx.addIssue({ code: "custom", path: ["workflow", "conditions", index], message: "review evidence is informational in a recipe and cannot be a required condition" });
    }
  });
  if (!recipe.workflow.conditions.some((condition) => condition.required !== false
    && condition.checker.kind !== "review"
    && (condition.checker.kind !== "diff" || (condition.checker.require?.length ?? 0) + (condition.checker.forbid?.length ?? 0) > 0))) {
    ctx.addIssue({ code: "custom", path: ["workflow", "conditions"], message: "at least one required condition must be independently satisfiable" });
  }
});

export type TaskRecipe = z.infer<typeof taskRecipeSchema>;

/** The keys of a schema shape that a document must carry: the ones that are not optional. `id` accepts anything, so it is
 *  never required. */
export function requiredKeys<S extends Record<string, { isOptional(): boolean }>>(shape: S): (keyof S & string)[] {
  return (Object.keys(shape) as (keyof S & string)[]).filter((key) => !shape[key]!.isOptional());
}
