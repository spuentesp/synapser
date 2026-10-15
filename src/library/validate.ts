// Library entries: what a document must hold to be written, and to be used by a run (plan 14 Q2.6 and Q5.1; plan 15).
// It reports EVERY problem, so an invalid edit is refused whole, with the full list. The shapes of agents and skills are
// zod schemas (schema.ts, plan 16 P16.3): they decide what each field is, which keys a variant requires, and which keys it
// does not know. The rules that need the operator's file stay here: an agent is checked as a profile, by validateProfile,
// the same rule the operator's file meets, and the providers, models, key names and destinations are checked against the
// policy. zod is the library's one dependency, and it lives in schema.ts.

import { type AgentProfile, BUILTIN_PROFILES, TIERS, validateProfile } from "../agents/profile.ts";
import { type ProviderConfig, validateProviderConfig } from "../model/config.ts";
import { isBlockedAddress } from "../model/destinations.ts";
import { isIP } from "node:net";
import type { LibraryKind } from "./store.ts";
import { extendingAgentSchema, MAX_SKILL_BYTES, MAX_TIMEOUT_MS, nativeAgentSchema, requiredKeys, skillSchema } from "./schema.ts";

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
      // Library providers stay openai-compatible (plan 17): the anthropic protocol serves CLI injection only. Same message as before the protocol existed.
      return [
        ...idProblems,
        ...providerIdProblems(at, id, policy),
        ...validateProviderConfig(id, d),
        ...(d["protocol"] === "anthropic" ? [`provider ${id}: unsupported protocol anthropic`] : []),
        ...keyNameProblems(at, d, policy),
        ...destinationProblems(at, d),
      ];
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

// ---- agents (plan 15 IC1, plan 14 Q5.1, plan 16 P16.3) -------------------------------------------------------------

/** Case (a): an agent that extends a profile sets only these. Everything else is the base's. Derived from the schema. */
export const EXTENDING_FIELDS = Object.keys(extendingAgentSchema.shape);
/** Case (b): a native agent of its own. It runs no command, so it has no argv, env, home or permissions. Derived from the schema. */
export const NATIVE_FIELDS = Object.keys(nativeAgentSchema.shape);
export const NATIVE_REQUIRED = requiredKeys(nativeAgentSchema.shape);
/** Fields only the operator's file may set, in either case: they run commands or widen what an agent may do. */
export const FILE_ONLY_FIELDS = ["argv", "env", "homeOverlay", "permissions", "maxBudgetUsd", "parser", "pool", "steerable", "disabledReason"];

/** How a field reads in a problem: "<field> must be <this>". Typed over the schemas' keys, so a field added to a schema
 *  without its sentence fails the typecheck here. `id` is not a field a problem can name: it takes anything. */
type AgentField = Exclude<keyof typeof extendingAgentSchema.shape | keyof typeof nativeAgentSchema.shape, "id">;
const AGENT_SAYS: Record<AgentField, string> = {
  extends: "the id of a profile",
  description: "a string",
  tags: "an array of strings",
  tier: `one of ${TIERS.join(", ")}`,
  timeoutMs: `a positive number of milliseconds, at most one hour (${MAX_TIMEOUT_MS})`,
  enabled: "a boolean",
  model: "a string",
  provider: "a string",
  temperature: "a number from 0 to 2",
  adapter: `"native"`,
  role: `"writer" or "advisor"`,
  nativeRole: `"worker" or "repair"`,
};

export interface ResolvedAgent {
  /** The profile the document stands for; null when any problem holds. */
  profile: AgentProfile | null;
  problems: string[];
}

/** The profile a library agent stands for, or every reason it does not. The write and every run use this one rule. */
export function resolveAgent(at: string, id: string, d: Record<string, unknown>, policy: LibraryPolicy): ResolvedAgent {
  const extending = d["extends"] !== undefined;
  const problems: string[] = [];
  if (policy.bases.some((b) => b.profile.id === id)) problems.push(`${at}: ${id} is a built-in or file profile; a library agent may add an id, not take one (plan 14 Q5.1)`);
  // the shape, the required keys and the unknown keys are the schema's. A shape problem stops the rules below it.
  const checked = extending ? extendingAgentSchema.safeParse(d) : nativeAgentSchema.safeParse(d);
  if (!checked.success) return { profile: null, problems: [...problems, ...shapeProblems(at, d, checked.error.issues, extending)] };
  if (problems.length) return { profile: null, problems };
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checked.data)) if (key !== "id" && key !== "extends") values[key] = value;
  return extending ? extendedAgent(at, id, String(d["extends"]), values, policy) : nativeAgent(at, id, values, policy);
}

/** The words of a schema's issues: one problem per field, and one per key the variant does not take. */
function shapeProblems(at: string, d: Record<string, unknown>, issues: readonly { code: string; path: readonly PropertyKey[]; keys?: string[] }[], extending: boolean): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys ?? []) {
        problems.push(
          FILE_ONLY_FIELDS.includes(key)
            ? `${at}: ${key} is set by the operator's file, never by a library agent (plan 15 IC1)`
            : `${at}: ${key} is not allowed in ${extending ? "an agent that extends a profile" : "a native library agent"} (plan 15 IC1)`,
        );
      }
      continue;
    }
    const key = String(issue.path[0]);
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(d[key] === undefined ? `${at}: ${key} is required for a native library agent` : `${at}: ${key} must be ${AGENT_SAYS[key as AgentField]}`);
  }
  return problems;
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
    // an own key only: "constructor" or "__proto__" would otherwise be read from Object.prototype (plan 16 P16.3)
    const provider = Object.hasOwn(policy.providers, profile.provider) ? policy.providers[profile.provider] : undefined;
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

/** D3: a library provider's address written as a literal must be public or loopback. Names are checked when they are called. */
function destinationProblems(at: string, d: Record<string, unknown>): string[] {
  if (typeof d["baseUrl"] !== "string") return [];
  let host: string;
  try {
    host = new URL(d["baseUrl"]).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return []; // validateProviderConfig reports a malformed address
  }
  return isIP(host) && isBlockedAddress(host) ? [`${at}: baseUrl ${host} is a private address; a library provider may not reach it (plan 15 D3)`] : [];
}

/** IC2: a library provider may name only the key variables the operator's file allows. */
function keyNameProblems(at: string, d: Record<string, unknown>, policy: LibraryPolicy): string[] {
  const names = d["apiKeyEnv"];
  if (!Array.isArray(names)) return [];
  return names
    .filter((n): n is string => typeof n === "string" && !policy.providerKeyEnv.includes(n))
    .map((n) => `${at}: apiKeyEnv ${n} is not in providerKeyEnv (the operator's allowlist in synapser.config.json)`);
}

/** A skill: name, description and content are required, tags are strings if given, and the content is at most
 *  MAX_SKILL_BYTES bytes (counted in bytes, not characters). */
function skillProblems(at: string, d: Record<string, unknown>): string[] {
  const checked = skillSchema.safeParse(d);
  const bad = new Set<string>(checked.success ? [] : checked.error.issues.map((issue) => String(issue.path[0])));
  const problems: string[] = [];
  if (bad.has("name")) problems.push(`${at}: name is required`);
  if (bad.has("description")) problems.push(`${at}: description must be a string`);
  if (bad.has("content")) problems.push(`${at}: content must be a non-empty string`);
  else if (Buffer.byteLength(d["content"] as string, "utf8") > MAX_SKILL_BYTES) problems.push(`${at}: content is larger than ${MAX_SKILL_BYTES} bytes`);
  if (bad.has("tags")) problems.push(`${at}: tags must be an array of strings`);
  return problems;
}
