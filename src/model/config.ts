import { readFileSync } from "node:fs";
import { ModelError, type Role } from "./types.ts";

export interface ProviderConfig {
  baseUrl: string;
  /** Environment variable names tried in order; the key itself is never in a config file. */
  apiKeyEnv: string[];
}
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
        baseUrl: "https://api.tokenfactory.nebius.com/v1/",
        apiKeyEnv: ["NEBIUS_API_KEY", "NEBIUS_TOKEN", "NEMOTRON_TOKEN"],
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
  for (const role of ["supervisor", "worker", "repair"] as const) {
    const r = cfg.roles[role];
    if (!r) throw new ModelError("CONFIG", `role ${role} is not configured`);
    if (!cfg.providers[r.provider]) throw new ModelError("CONFIG", `role ${role}: unknown provider ${r.provider}`);
    if (!r.model) throw new ModelError("CONFIG", `role ${role}: no model`);
  }
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!/^https:\/\//.test(p.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(p.baseUrl)) {
      throw new ModelError("CONFIG", `provider ${name}: baseUrl must be https (or loopback for tests)`);
    }
  }
}

/** Resolve the key from the environment. Throws with the NAMES tried, never a value. */
export function resolveApiKey(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): string {
  for (const n of p.apiKeyEnv) {
    const v = env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new ModelError("CONFIG", `no API key in environment (tried ${p.apiKeyEnv.join(", ")})`);
}
