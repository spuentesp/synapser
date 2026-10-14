// The shapes of the library documents this layer owns: agents and skills (plan 16, P16.3). zod decides what each field is,
// which fields a variant requires, and which keys it does not know, so none of that is kept in tables a second time. What
// a document may do stays in validate.ts, with the rules that need the operator's file: the profiles an agent may extend,
// the pools, the providers and their models, the key names and the destinations. Providers and workflow drafts are not
// here: their validators are shared with the operator's file and with the workflow manager.

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

/** The keys of a schema shape that a document must carry: the ones that are not optional. `id` accepts anything, so it is
 *  never required. */
export function requiredKeys<S extends Record<string, { isOptional(): boolean }>>(shape: S): (keyof S & string)[] {
  return (Object.keys(shape) as (keyof S & string)[]).filter((key) => !shape[key]!.isOptional());
}
