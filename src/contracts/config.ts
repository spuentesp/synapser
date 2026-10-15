// Plan 18 E2: contracts for the configuration surface. A contract is the exact shape a client may send or receive.
// The schemas are strict: an unexpected field is a contract change, and a contract change fails a test (contracts README).
// Semantic rules (a model the provider declares, a metadata address, a reserved variable) stay in the validators; these
// schemas describe the shape only.
import { z } from "zod";

export const ProviderBody = z.strictObject({
  protocol: z.enum(["openai-compatible", "anthropic"]),
  baseUrl: z.string(),
  apiKeyEnv: z.array(z.string()),
  models: z.array(z.strictObject({ id: z.string(), usdPer1MIn: z.number().optional(), usdPer1MOut: z.number().optional() })),
});

export const RoleBody = z.strictObject({
  provider: z.string(),
  model: z.string(),
  temperature: z.number().optional(),
  fallbacks: z.array(z.string()).optional(),
});

/** An agent is written in the form of the operator's file; its full rules belong to the loader. */
export const AgentBody = z.record(z.string(), z.unknown());

export const ConfigToolInputs = {
  config_put_provider: z.strictObject({ id: z.string(), provider: ProviderBody }),
  config_put_agent: z.strictObject({ id: z.string(), agent: AgentBody }),
  config_put_role: z.strictObject({ role: z.string(), assignment: RoleBody }),
} as const;

/** Answers of PUT /api/config/... */
export const ConfigWriteOk = z.strictObject({ ok: z.literal(true) });
export const ConfigWriteRefused = z.strictObject({ error: z.literal("INVALID_CONFIG"), errors: z.array(z.string()).min(1) });
