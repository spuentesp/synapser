// Synapser configuration (plan 13 §9, first cut). One JSON file; everything has a safe default; an
// invalid file is rejected WHOLE with every problem listed (K2), never half-applied.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type AgentProfile, BUILTIN_PROFILES, TIERS, validateProfile } from "../agents/profile.ts";
import { PARSERS } from "../agents/usage.ts";
import type { PoolSpec } from "../orchestration/pools.ts";
import { DEFAULT_POLICY, type Policy, validatePolicy } from "../effects/policy.ts";
import type { AllowedCommand } from "../validation/runner.ts";

export interface SynapserConfig {
  workspace: string;
  stateDir: string;
  commands: AllowedCommand[];
  profiles: AgentProfile[];
  pools: PoolSpec[];
  startRequiresApproval: boolean;
  /** Which side effects agents may ask for and under which decision (default: ask for commit/push, deny the rest). */
  policy: Policy;
  /** Identity Synapser commits with when the repository has none configured. */
  identity: { name: string; email: string };
  research: boolean;
  /** The advisor (plan 13 §6). `pushback: "writes"` critiques write tasks with web evidence before they run. */
  advisor: { enabled: boolean; pushback: "off" | "writes"; maxConsults: number; maxPerTask: number };
  knownUsdPerRun: Record<string, number>;
  limits: { concurrency: number; maxRepairRounds: number; maxTaskAttempts: number; missionMs: number };
  delegation: { maxDepth: number; maxTasks: number; maxPerTask: number };
  /** Where the config came from (for `config show`); null = defaults. */
  source: string | null;
}

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid configuration:\n- ${errors.join("\n- ")}`);
    this.name = "ConfigError";
    this.errors = errors;
  }
}

const DEFAULTS = {
  startRequiresApproval: false,
  research: true,
  limits: { concurrency: 3, maxRepairRounds: 2, maxTaskAttempts: 2, missionMs: 15 * 60_000 },
  delegation: { maxDepth: 2, maxTasks: 12, maxPerTask: 3 },
};

export function loadConfig(o: { path?: string; cwd?: string } = {}): SynapserConfig {
  const cwd = o.cwd ?? process.cwd();
  const path = o.path ? resolve(cwd, o.path) : existsSync(join(cwd, "synapser.config.json")) ? join(cwd, "synapser.config.json") : null;
  let raw: Record<string, unknown> = {};
  if (path) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new ConfigError([`${path}: ${String((e as Error).message)}`]);
    }
  }
  const errors: string[] = [];
  const base = path ? dirname(path) : cwd;
  const abs = (p: unknown, d: string): string => (typeof p === "string" && p.length ? (isAbsolute(p) ? p : resolve(base, p)) : d);

  const workspace = abs(raw["workspace"], cwd);
  if (!existsSync(workspace)) errors.push(`workspace "${workspace}" does not exist`);
  const stateDir = abs(raw["stateDir"], join(dirname(workspace), ".synapser-state"));

  const commands: AllowedCommand[] = [];
  if (raw["commands"] !== undefined) {
    if (!Array.isArray(raw["commands"])) errors.push("commands must be an array");
    else {
      const seen = new Set<string>();
      raw["commands"].forEach((c, i) => {
        const x = c as { id?: unknown; argv?: unknown; timeoutMs?: unknown; env?: unknown };
        if (typeof x?.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(x.id)) return void errors.push(`commands[${i}].id must match [a-z0-9][a-z0-9_-]*`);
        if (seen.has(x.id)) return void errors.push(`commands[${i}].id "${x.id}" is duplicated`);
        seen.add(x.id);
        if (!Array.isArray(x.argv) || x.argv.length === 0 || x.argv.some((a) => typeof a !== "string")) return void errors.push(`commands[${i}].argv must be a non-empty array of strings (a program and its arguments, never a shell string)`);
        commands.push({ id: x.id, argv: x.argv as string[], ...(typeof x.timeoutMs === "number" ? { timeoutMs: x.timeoutMs } : {}), ...(x.env && typeof x.env === "object" ? { env: x.env as Record<string, string> } : {}) });
      });
    }
  }

  let profiles: AgentProfile[] = BUILTIN_PROFILES.filter((p) => p.enabled);
  if (raw["profiles"] !== undefined) {
    if (!Array.isArray(raw["profiles"]) || raw["profiles"].some((p) => typeof p !== "string")) errors.push("profiles must be an array of profile ids");
    else {
      const ids = raw["profiles"] as string[];
      const unknown = ids.filter((id) => !BUILTIN_PROFILES.some((p) => p.id === id));
      if (unknown.length) errors.push(`unknown profile(s): ${unknown.join(", ")} (known: ${BUILTIN_PROFILES.map((p) => p.id).join(", ")})`);
      profiles = BUILTIN_PROFILES.filter((p) => ids.includes(p.id));
    }
  }

  // ---- configurable agents (plan 13 §7): extend a builtin, point at any endpoint, or wrap any CLI ------
  if (raw["agents"] !== undefined) {
    if (!Array.isArray(raw["agents"])) errors.push("agents must be an array");
    else {
      raw["agents"].forEach((a, i) => {
        const x = a as Record<string, unknown>;
        const at = `agents[${i}]`;
        if (!x || typeof x !== "object" || typeof x["id"] !== "string") return void errors.push(`${at}.id is required`);
        if (profiles.some((p) => p.id === x["id"]) || BUILTIN_PROFILES.some((p) => p.id === x["id"] && x["extends"] !== x["id"])) {
          if (x["extends"] !== x["id"]) return void errors.push(`${at}.id "${String(x["id"])}" is already a profile; use a new id or "extends" it under another id`);
        }
        let base: AgentProfile | undefined;
        if (typeof x["extends"] === "string") {
          base = BUILTIN_PROFILES.find((p) => p.id === x["extends"]);
          if (!base) return void errors.push(`${at}.extends "${String(x["extends"])}" is not a builtin profile`);
        }
        const tier = x["tier"];
        if (tier !== undefined && !(TIERS as readonly unknown[]).includes(tier)) return void errors.push(`${at}.tier must be one of ${TIERS.join(", ")}`);
        const parser = (x["parser"] ?? base?.parser ?? "plain") as string;
        if (!(parser in PARSERS)) return void errors.push(`${at}.parser "${parser}" is unknown (${Object.keys(PARSERS).join(", ")})`);
        const argv = (x["argv"] ?? base?.argv ?? []) as unknown;
        if (!Array.isArray(argv) || argv.some((q) => typeof q !== "string")) return void errors.push(`${at}.argv must be an array of strings`);
        const ep = x["endpoint"] as AgentProfile["endpoint"] | undefined;
        const p: AgentProfile = {
          ...(base ?? { description: "", role: "writer", argv: [], parser: "plain", timeoutMs: 300_000, tags: [], enabled: true }),
          id: x["id"] as string,
          description: typeof x["description"] === "string" ? (x["description"] as string) : (base?.description ?? ""),
          role: (x["role"] === "advisor" || x["role"] === "writer" ? x["role"] : (base?.role ?? "writer")) as AgentProfile["role"],
          adapter: (ep ? "native" : (x["adapter"] ?? base?.adapter ?? "cli-oneshot")) as NonNullable<AgentProfile["adapter"]>,
          argv: argv as string[],
          parser: parser as AgentProfile["parser"],
          timeoutMs: typeof x["timeoutMs"] === "number" ? (x["timeoutMs"] as number) : (base?.timeoutMs ?? 300_000),
          tags: Array.isArray(x["tags"]) ? (x["tags"] as string[]) : (base?.tags ?? []),
          enabled: x["enabled"] === false ? false : true,
          ...(tier ? { tier: tier as AgentProfile["tier"] } : {}),
          ...(ep ? { endpoint: ep } : {}),
          ...(Array.isArray(x["homeOverlay"]) ? { homeOverlay: x["homeOverlay"] as string[] } : {}),
          ...(x["permissions"] && typeof x["permissions"] === "object" ? { permissions: x["permissions"] as AgentProfile["permissions"] } : {}),
          ...(typeof x["maxBudgetUsd"] === "number" ? { maxBudgetUsd: x["maxBudgetUsd"] } : {}),
          ...(x["steerable"] === "turn" || x["steerable"] === "attempt" ? { steerable: x["steerable"] } : {}),
        };
        const problems = validateProfile(p);
        if (problems.length) return void errors.push(...problems.map((m) => `${at}: ${m}`));
        profiles = [...profiles.filter((q) => q.id !== p.id), p];
      });
    }
  }
  const pools: PoolSpec[] = [];
  if (raw["pools"] !== undefined) {
    if (!Array.isArray(raw["pools"])) errors.push("pools must be an array");
    else {
      const claimed = new Set<string>();
      raw["pools"].forEach((pl, i) => {
        const x = pl as { id?: unknown; members?: unknown; maxConcurrent?: unknown };
        if (typeof x?.id !== "string" || !Array.isArray(x.members) || typeof x.maxConcurrent !== "number" || x.maxConcurrent < 1) return void errors.push(`pools[${i}] needs id, members[] and maxConcurrent >= 1`);
        for (const m of x.members as string[]) {
          if (!profiles.some((q) => q.id === m)) errors.push(`pools[${i}].members: unknown profile "${m}"`);
          if (claimed.has(m)) errors.push(`pools[${i}].members: "${m}" is already in another pool`);
          claimed.add(m);
        }
        pools.push({ id: x.id, members: x.members as string[], maxConcurrent: x.maxConcurrent });
      });
    }
  }
  profiles = profiles.map((p) => ({ ...p, ...(pools.find((pl) => pl.members.includes(p.id)) ? { pool: pools.find((pl) => pl.members.includes(p.id))!.id } : {}) }));

  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (v === undefined) return d;
    if (typeof v !== "boolean") errors.push(`${k} must be a boolean`);
    return typeof v === "boolean" ? v : d;
  };
  const nums = <T extends Record<string, number>>(k: string, d: T): T => {
    const v = raw[k];
    if (v === undefined) return d;
    if (typeof v !== "object" || v === null) {
      errors.push(`${k} must be an object`);
      return d;
    }
    const out: Record<string, number> = { ...d };
    for (const [key, val] of Object.entries(v)) {
      if (!(key in d)) errors.push(`${k}.${key} is not a known setting (${Object.keys(d).join(", ")})`);
      else if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) errors.push(`${k}.${key} must be a positive number`);
      else out[key] = val;
    }
    return out as T;
  };
  const known: Record<string, number> = {};
  if (raw["knownUsdPerRun"] !== undefined) {
    for (const [k, v] of Object.entries(raw["knownUsdPerRun"] as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 0) known[k] = v;
      else errors.push(`knownUsdPerRun.${k} must be a non-negative number`);
    }
  }

  let policy: Policy = DEFAULT_POLICY;
  if (raw["policy"] !== undefined) {
    let doc: unknown = raw["policy"];
    if (typeof doc === "string") {
      try {
        doc = JSON.parse(readFileSync(abs(doc, ""), "utf8"));
      } catch (e) {
        errors.push(`policy file: ${String((e as Error).message)}`);
        doc = null;
      }
    }
    if (doc !== null) {
      const v = validatePolicy(doc);
      if (v.ok) policy = v.policy;
      else errors.push(...v.errors.map((e) => `policy: ${e}`));
    }
  }
  const id = raw["identity"] as { name?: unknown; email?: unknown } | undefined;
  const identity = id && typeof id.name === "string" && typeof id.email === "string" ? { name: id.name, email: id.email } : { name: "Synapser", email: "synapser@localhost" };

  const adv = (raw["advisor"] ?? {}) as { enabled?: unknown; pushback?: unknown; maxConsults?: unknown; maxPerTask?: unknown };
  if (adv.enabled !== undefined && typeof adv.enabled !== "boolean") errors.push("advisor.enabled must be a boolean");
  if (adv.pushback !== undefined && adv.pushback !== "off" && adv.pushback !== "writes") errors.push('advisor.pushback must be "off" or "writes"');
  for (const k of ["maxConsults", "maxPerTask"] as const) if (adv[k] !== undefined && (typeof adv[k] !== "number" || (adv[k] as number) < 1)) errors.push(`advisor.${k} must be a positive number`);
  const advisor = {
    enabled: adv.enabled === false ? false : true,
    pushback: adv.pushback === "writes" ? ("writes" as const) : ("off" as const),
    maxConsults: typeof adv.maxConsults === "number" ? adv.maxConsults : 6,
    maxPerTask: typeof adv.maxPerTask === "number" ? adv.maxPerTask : 3,
  };

  const cfg: SynapserConfig = {
    workspace, stateDir, commands, profiles, pools, policy, identity, advisor,
    startRequiresApproval: bool("startRequiresApproval", DEFAULTS.startRequiresApproval),
    research: bool("research", DEFAULTS.research),
    knownUsdPerRun: known,
    limits: nums("limits", DEFAULTS.limits),
    delegation: nums("delegation", DEFAULTS.delegation),
    source: path,
  };
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}
