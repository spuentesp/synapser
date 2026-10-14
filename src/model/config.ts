import { readFileSync } from "node:fs";
import type { ModelPrice } from "./pricing.ts";
import { ModelError, type Role } from "./types.ts";

export interface ProviderConfig {
  protocol: "openai-compatible";
  baseUrl: string;
  /** Environment variable names tried in order; the key itself is never in a config file. */
  apiKeyEnv: string[];
  models: { id: string; usdPer1MIn?: number; usdPer1MOut?: number }[];
}
export type ProviderModelConfig = ProviderConfig["models"][number];
export interface RoleConfig {
  provider: string;
  model: string;
  temperature: number;
  /** Tried in order when the primary fails with UNAVAILABLE or model-not-found. Always reported. */
  fallbacks?: string[];
}
export interface ModelConfig {
  providers: Record<string, ProviderConfig>;
  roles: Record<Role, RoleConfig>;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
}

export function defaultModelConfig(): ModelConfig {
  return {
    providers: {
      tokenfactory: {
        protocol: "openai-compatible",
        baseUrl: "https://api.tokenfactory.nebius.com/v1/",
        apiKeyEnv: ["NEBIUS_API_KEY", "NEBIUS_TOKEN", "NEMOTRON_TOKEN"],
        models: [
          { id: "nvidia/Nemotron-3_5-Lightning", usdPer1MIn: 0.06, usdPer1MOut: 0.24 },
          { id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", usdPer1MIn: 0.06, usdPer1MOut: 0.24 },
          { id: "nvidia/nemotron-3-super-120b-a12b", usdPer1MIn: 0.3, usdPer1MOut: 0.9 },
          { id: "nvidia/Nemotron-3-Ultra-550b-a55b", usdPer1MIn: 1, usdPer1MOut: 3 },
        ],
      },
    },
    // Evidence (scripts/mission-bench.ts, 3-agent discount mission, n=5/model, 13 oct 2026):
    //   Super 120B: 4/5 accepted (3 without repair), ~$0.035, ~30 s
    //   Lightning:  1/5 accepted, ~$0.012 — fine alone (5/5 single task), unreliable with 3 concurrent agents
    // so Super is the default for every role and Lightning is the cheap fallback.
    roles: {
      supervisor: { provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b", temperature: 0.2 },
      worker: {
        provider: "tokenfactory",
        model: "nvidia/nemotron-3-super-120b-a12b",
        temperature: 0,
        fallbacks: ["nvidia/Nemotron-3_5-Lightning", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"],
      },
      repair: {
        provider: "tokenfactory",
        model: "nvidia/nemotron-3-super-120b-a12b",
        temperature: 0,
        fallbacks: ["nvidia/Nemotron-3_5-Lightning"],
      },
      // the coordinator's advisor and the UI chat: judgement and conversation, never execution
      advisor: { provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b", temperature: 0.2 },
      chat: { provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b", temperature: 0.3, fallbacks: ["nvidia/Nemotron-3_5-Lightning"] },
    },
    timeoutMs: 60_000,
    maxRetries: 2,
    maxConcurrency: 4,
  };
}

export function loadModelConfig(path: string): ModelConfig {
  const base = defaultModelConfig();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelConfig>;
  const cfg: ModelConfig = {
    ...base,
    ...raw,
    providers: { ...base.providers, ...(raw.providers ?? {}) },
    roles: { ...base.roles, ...(raw.roles ?? {}) },
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: ModelConfig): void {
  const providerErrors: string[] = [];
  for (const [name, provider] of Object.entries(cfg.providers)) {
    providerErrors.push(...validateProviderConfig(name, provider));
  }
  if (providerErrors.length) throw new ModelError("CONFIG", providerErrors.join("; "));
  for (const role of ["supervisor", "worker", "repair", "advisor", "chat"] as const) {
    const r = cfg.roles[role];
    if (!r) throw new ModelError("CONFIG", `role ${role} is not configured`);
    const provider = cfg.providers[r.provider];
    if (!provider) throw new ModelError("CONFIG", `role ${role}: unknown provider ${r.provider}`);
    if (!r.model) throw new ModelError("CONFIG", `role ${role}: no model`);
    if (!provider.models.some((model) => model.id === r.model)) throw new ModelError("CONFIG", `role ${role}: model ${r.model} is not declared by provider ${r.provider}`);
    for (const fallback of r.fallbacks ?? []) {
      if (!provider.models.some((model) => model.id === fallback)) throw new ModelError("CONFIG", `role ${role}: fallback ${fallback} is not declared by provider ${r.provider}`);
    }
  }
}

/** Validate one provider without throwing so whole-file configuration can report every problem. */
export function validateProviderConfig(name: string, provider: unknown): string[] {
  const at = `provider ${name}`;
  if (!provider || typeof provider !== "object") return [`${at}: must be an object`];
  const p = provider as Partial<ProviderConfig>;
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) errors.push(`${at}: id must be a lowercase slug`);
  if (p.protocol !== "openai-compatible") errors.push(`${at}: unsupported protocol ${String(p.protocol)}`);
  if (typeof p.baseUrl !== "string" || (!/^https:\/\//.test(p.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(p.baseUrl))) {
    errors.push(`${at}: baseUrl must be https (or loopback for tests)`);
  }
  if (!Array.isArray(p.apiKeyEnv) || p.apiKeyEnv.length === 0 || p.apiKeyEnv.some((item) => typeof item !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(item))) {
    errors.push(`${at}: apiKeyEnv must contain environment variable names`);
  }
  if (!Array.isArray(p.models) || p.models.length === 0) {
    errors.push(`${at}: models must be a non-empty array`);
  } else {
    const ids = new Set<string>();
    p.models.forEach((raw, index) => {
      const model = raw as Partial<ProviderModelConfig>;
      if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()) {
        errors.push(`${at}: models[${index}].id is required`);
        return;
      }
      if (ids.has(model.id)) errors.push(`${at}: model ${model.id} is duplicated`);
      ids.add(model.id);
      for (const field of ["usdPer1MIn", "usdPer1MOut"] as const) {
        const value = model[field];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) errors.push(`${at}: models[${index}].${field} must be a non-negative finite number`);
      }
      if ((model.usdPer1MIn === undefined) !== (model.usdPer1MOut === undefined)) errors.push(`${at}: models[${index}] must declare both input and output prices, or neither`);
    });
  }
  return errors;
}

/** Resolve the key from the environment. Throws with the NAMES tried, never a value. */
export function resolveApiKey(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): string {
  for (const n of p.apiKeyEnv) {
    const v = env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new ModelError("CONFIG", `no API key in environment (tried ${p.apiKeyEnv.join(", ")})`);
}

/** Convert a provider's declared price into the recorder's canonical price shape. */
export function declaredModelPrice(provider: ProviderConfig, modelId: string): ModelPrice | null {
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model?.usdPer1MIn === undefined || model.usdPer1MOut === undefined) return null;
  return { inputPerMillionUsd: model.usdPer1MIn, outputPerMillionUsd: model.usdPer1MOut };
}

/** A model config whose every role goes to ONE custom OpenAI-compatible endpoint (an `endpoint` agent). */
export function modelConfigForProvider(providerId: string, provider: ProviderConfig, model: string, temperature = 0): ModelConfig {
  const base = defaultModelConfig();
  const role = { provider: providerId, model, temperature };
  const cfg: ModelConfig = {
    ...base,
    providers: { [providerId]: provider },
    roles: { supervisor: role, worker: role, repair: role, advisor: role, chat: role },
    maxRetries: 1,
  };
  validateConfig(cfg);
  return cfg;
}

/** Compatibility helper for callers that still hold the pre-library inline endpoint shape. */
export function modelConfigForEndpoint(ep: { baseUrl: string; model: string; apiKeyEnv: readonly string[]; temperature?: number }): ModelConfig {
  return modelConfigForProvider("custom", {
    protocol: "openai-compatible", baseUrl: ep.baseUrl, apiKeyEnv: [...ep.apiKeyEnv], models: [{ id: ep.model }],
  }, ep.model, ep.temperature ?? 0);
}
