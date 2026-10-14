// Library entries: what a document must hold to be written, and to be used by a run (plan 14 Q2.6 and Q5.1; plan 15).
// It reports EVERY problem, so an invalid edit is refused whole, with the full list. The rules are data: the fields a
// library agent may set, and the shape of each, are tables below. Semantic rules are not copied here: an agent is checked
// as a profile, by validateProfile, the same rule the operator's file meets. This file adds no dependency.

import { type AgentProfile, BUILTIN_PROFILES, TIERS, validateProfile } from "../agents/profile.ts";
import { type ProviderConfig, validateProviderConfig } from "../model/config.ts";
import type { LibraryKind } from "./store.ts";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** A profile a library agent may extend, and whether the operator's file enables it (plan 15 IC1). */
export interface LibraryBase {
  profile: AgentProfile;
  enabledByFile: boolean;
}

/** What the operator's file allows a library document to name, and what it already owns (plan 15, plan 14 Q5.1). */
export interface LibraryPolicy {
  /** Key variable names a library provider may use (IC2). */
  providerKeyEnv: readonly string[];
  /** Profiles a library agent may extend: the built-in ones and the operator's file (IC1). */
  bases: readonly LibraryBase[];
  /** Providers a native agent may name: the operator's file's, then the library's. */
  providers: Readonly<Record<string, ProviderConfig>>;
  /** Provider ids the operator's file owns. A library document may add an id, never take one (solo añadir). */
  reservedProviderIds: readonly string[];
}

/** Allows nothing. The default for a caller that has not read the operator's file. */
export const NO_LIBRARY_POLICY: LibraryPolicy = { providerKeyEnv: [], bases: [], providers: {}, reservedProviderIds: [] };

/** The policy a loaded configuration implies. As in the loader, the operator's list replaces a built-in with the same id. */
export function libraryPolicyOf(
  cfg: { providers: Readonly<Record<string, ProviderConfig>>; providerKeyEnv: readonly string[]; profiles: readonly AgentProfile[] },
  libraryProviders: Readonly<Record<string, ProviderConfig>> = {},
): LibraryPolicy {
  const onFile = new Map(cfg.profiles.map((p) => [p.id, p]));
  const effective = new Map([...BUILTIN_PROFILES, ...cfg.profiles].map((p) => [p.id, p]));
  return {
    providerKeyEnv: cfg.providerKeyEnv,
    bases: [...effective.values()].map((profile) => ({ profile, enabledByFile: onFile.get(profile.id)?.enabled === true })),
    providers: { ...cfg.providers, ...libraryProviders },
    reservedProviderIds: Object.keys(cfg.providers),
  };
}

export function validateLibraryDocument(kind: LibraryKind, id: string, document: unknown, policy: LibraryPolicy = NO_LIBRARY_POLICY): string[] {
  const at = `${kind}/${id}`;
  if (!document || typeof document !== "object" || Array.isArray(document)) return [`${at}: the document must be a JSON object`];
  const d = document as Record<string, unknown>;
  const idProblems = d["id"] !== undefined && d["id"] !== id ? [`${at}: document id ${JSON.stringify(d["id"])} does not match ${id}`] : [];
  switch (kind) {
    case "providers":
      return [...idProblems, ...providerIdProblems(at, id, policy), ...validateProviderConfig(id, d), ...keyNameProblems(at, d, policy)];
    case "agents":
      return [...idProblems, ...resolveAgent(at, id, d, policy).problems];
    case "skills":
      return [...idProblems, ...skillProblems(at, d)];
    case "templates":
      return idProblems;
  }
}

/** Q5.1: a library provider may add an id, never take one the operator's file owns. */
function providerIdProblems(at: string, id: string, policy: LibraryPolicy): string[] {
  return policy.reservedProviderIds.includes(id)
    ? [`${at}: provider id ${id} belongs to the operator's file; a library document may add an id, not take one (plan 14 Q5.1)`]
    : [];
}

// ---- agents (plan 15 IC1, plan 14 Q5.1) ----------------------------------------------------------------------------

/** Case (a): an agent that extends a profile sets only these. Everything else is the base's. */
export const EXTENDING_FIELDS = ["id", "extends", "description", "tags", "tier", "timeoutMs", "enabled", "model", "provider", "temperature"];
/** Case (b): a native agent of its own. It runs no command, so it has no argv, env, home or permissions. */
export const NATIVE_FIELDS = ["id", "adapter", "role", "nativeRole", "description", "tags", "tier", "timeoutMs", "enabled", "model", "provider", "temperature"];
export const NATIVE_REQUIRED = ["adapter", "role", "description", "tags", "timeoutMs", "model", "provider"];
/** Fields only the operator's file may set, in either case: they run commands or widen what an agent may do. */
export const FILE_ONLY_FIELDS = ["argv", "env", "homeOverlay", "permissions", "maxBudgetUsd", "parser", "pool", "steerable", "disabledReason"];

const isString = (v: unknown): boolean => typeof v === "string";
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isTier = (v: unknown): boolean => (TIERS as readonly unknown[]).includes(v);
const isTimeout = (v: unknown): boolean => typeof v === "number" && v > 0 && v <= MAX_TIMEOUT_MS;
const isTemperature = (v: unknown): boolean => typeof v === "number" && v >= 0 && v <= 2;

/** The shape each agent field must have, and how a problem names it. Semantic rules run only after these hold. */
const AGENT_SHAPES: Readonly<Record<string, { ok: (v: unknown) => boolean; says: string }>> = {
  description: { ok: isString, says: "a string" },
  tags: { ok: isStringList, says: "an array of strings" },
  tier: { ok: isTier, says: `one of ${TIERS.join(", ")}` },
  timeoutMs: { ok: isTimeout, says: `a positive number of milliseconds, at most one hour (${MAX_TIMEOUT_MS})` },
  enabled: { ok: isBoolean, says: "a boolean" },
  model: { ok: isString, says: "a string" },
  provider: { ok: isString, says: "a string" },
  temperature: { ok: isTemperature, says: "a number from 0 to 2" },
  adapter: { ok: (v) => v === "native", says: `"native"` },
  role: { ok: (v) => v === "writer" || v === "advisor", says: `"writer" or "advisor"` },
  nativeRole: { ok: (v) => v === "worker" || v === "repair", says: `"worker" or "repair"` },
};

export interface ResolvedAgent {
  /** The profile the document stands for; null when any problem holds. */
  profile: AgentProfile | null;
  problems: string[];
}

/** The profile a library agent stands for, or every reason it does not. The write and every run use this one rule. */
export function resolveAgent(at: string, id: string, d: Record<string, unknown>, policy: LibraryPolicy): ResolvedAgent {
  const extendsId = d["extends"];
  const extending = extendsId !== undefined;
  const allowed = extending ? EXTENDING_FIELDS : NATIVE_FIELDS;
  const problems: string[] = [];
  if (extending && typeof extendsId !== "string") problems.push(`${at}: extends must be the id of a profile`);
  if (policy.bases.some((b) => b.profile.id === id)) problems.push(`${at}: ${id} is a built-in or file profile; a library agent may add an id, not take one (plan 14 Q5.1)`);
  for (const key of Object.keys(d)) {
    if (allowed.includes(key)) continue;
    problems.push(
      FILE_ONLY_FIELDS.includes(key)
        ? `${at}: ${key} is set by the operator's file, never by a library agent (plan 15 IC1)`
        : `${at}: ${key} is not allowed in ${extending ? "an agent that extends a profile" : "a native library agent"} (plan 15 IC1)`,
    );
  }
  // only the values whose shape holds reach the semantic rules
  const values: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key === "id" || key === "extends" || d[key] === undefined) continue;
    const shape = AGENT_SHAPES[key];
    if (shape?.ok(d[key])) values[key] = d[key];
    else problems.push(`${at}: ${key} must be ${shape?.says ?? "valid"}`);
  }
  if (!extending) {
    for (const key of NATIVE_REQUIRED) {
      if (d[key] === undefined) problems.push(`${at}: ${key} is required for a native library agent`);
    }
  }
  if (problems.length) return { profile: null, problems };
  return extending ? extendedAgent(at, id, String(extendsId), values, policy) : nativeAgent(at, id, values, policy);
}

/** Case (a). The base is the operator's own profile, so what it executes is already decided; the document only tunes it. */
function extendedAgent(at: string, id: string, baseId: string, values: Record<string, unknown>, policy: LibraryPolicy): ResolvedAgent {
  const base = policy.bases.find((b) => b.profile.id === baseId);
  if (!base) return { profile: null, problems: [`${at}: extends ${baseId}, which is neither a built-in profile nor one of the operator's file`] };
  if (base.profile.pool) return { profile: null, problems: [`${at}: extends ${baseId}, which the operator's file pools: a library agent does not join a pool (plan 15 IC1)`] };
  if (values["enabled"] === true && !base.enabledByFile) return { profile: null, problems: [`${at}: enabled true needs the operator's file to enable ${baseId} (plan 15 IC1)`] };
  // a document can switch its base off, never on: the file's enabling is the only one that counts
  const profile = { ...base.profile, ...(values as Partial<AgentProfile>), id, enabled: base.enabledByFile && values["enabled"] !== false } as AgentProfile;
  return checkAgent(at, profile, policy);
}

/** Case (b). A native agent runs no command, so argv and parser are the profile type's placeholders, not the document's. */
function nativeAgent(at: string, id: string, values: Record<string, unknown>, policy: LibraryPolicy): ResolvedAgent {
  const profile = { id, argv: [], parser: "plain", enabled: true, ...(values as Partial<AgentProfile>) } as AgentProfile;
  return checkAgent(at, profile, policy);
}

/** The semantic rules: validateProfile on the whole profile, then the provider it names, which must exist and declare the model. */
function checkAgent(at: string, profile: AgentProfile, policy: LibraryPolicy): ResolvedAgent {
  const problems = validateProfile(profile).map((p) => `${at}: ${p}`);
  if (profile.provider) {
    const provider = policy.providers[profile.provider];
    if (!provider) problems.push(`${at}: provider ${profile.provider} is defined neither by the operator's file nor by the library`);
    else if (!provider.models.some((m) => m.id === profile.model)) problems.push(`${at}: model ${profile.model ?? "(missing)"} is not declared by provider ${profile.provider}`);
  }
  return { profile: problems.length ? null : profile, problems };
}

/** The provider a library agent document runs on: its own, or its base's (a file provider, never a library one). */
export function providerOfAgent(d: Record<string, unknown>, policy: LibraryPolicy): string | undefined {
  if (typeof d["provider"] === "string") return d["provider"];
  if (typeof d["extends"] !== "string") return undefined;
  return policy.bases.find((b) => b.profile.id === d["extends"])?.profile.provider;
}

// ---- providers and skills --------------------------------------------------------------------------------------------

/** IC2: a library provider may name only the key variables the operator's file allows. */
function keyNameProblems(at: string, d: Record<string, unknown>, policy: LibraryPolicy): string[] {
  const names = d["apiKeyEnv"];
  if (!Array.isArray(names)) return [];
  return names
    .filter((n): n is string => typeof n === "string" && !policy.providerKeyEnv.includes(n))
    .map((n) => `${at}: apiKeyEnv ${n} is not in providerKeyEnv (the operator's allowlist in synapser.config.json)`);
}

function skillProblems(at: string, d: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { name, description, content, tags } = d;
  if (typeof name !== "string" || !name.trim()) problems.push(`${at}: name is required`);
  if (typeof description !== "string") problems.push(`${at}: description must be a string`);
  if (typeof content !== "string" || !content.trim()) problems.push(`${at}: content must be a non-empty string`);
  else if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) problems.push(`${at}: content is larger than ${MAX_SKILL_BYTES} bytes`);
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) problems.push(`${at}: tags must be an array of strings`);
  return problems;
}
