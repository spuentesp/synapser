// Plan 17 P17.8: the operator's providers, roles and agents change at run time (hot reload). A change is validated
// against the whole configuration first, then written atomically to the operator's file, then applied in place to the
// objects the runtime already holds, so every holder sees it without a restart. Nothing is written when validation fails.
// Every change, applied or refused, is appended to <stateDir>/config-changes.jsonl: the kind, the id, the outcome, the
// validator problems, and a digest of the table before and after. It never holds a key value.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../agents/profile.ts";
import { metadataEndpointProblems, type ProviderConfig, type RoleConfig, SYSTEM_ROLES, systemModelConfig, validateProviderConfig } from "../model/config.ts";
import { ModelError, type Role } from "../model/types.ts";
import { ConfigError, loadConfig } from "./load.ts";

export class ConfigWriteError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

export type ConfigChange =
  | { kind: "providers"; id: string; value: unknown }
  | { kind: "roles"; id: string; value: unknown }
  | { kind: "agents"; id: string; value: unknown };

export interface LiveConfig {
  configPath?: string | null;
  /** Where the change log is kept: <stateDir>/config-changes.jsonl. Absent ⇒ no log (tests only). */
  stateDir?: string;
  providers: Record<string, ProviderConfig>;
  roles: Record<Role, RoleConfig>;
  /** The live agent list. Replaced in place, so the runtime's holders see new and changed agents. */
  profiles?: AgentProfile[];
}

/** Makes `target` equal to `next` without replacing the object, so every holder of `target` sees the change. */
function replaceInPlace(target: object, next: object): void {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!Object.hasOwn(next, key)) delete t[key];
  for (const [key, value] of Object.entries(next)) t[key] = value;
}

const digest = (live: LiveConfig): string =>
  createHash("sha256").update(JSON.stringify({ providers: live.providers, roles: live.roles, profiles: live.profiles?.map((p) => p.id) ?? [] })).digest("hex").slice(0, 16);

/** One line per change. Problems are validator messages, which name variables and never carry a key value. */
function audit(live: LiveConfig, change: ConfigChange, outcome: "applied" | "refused", before: string, problems: string[], after: string | null): void {
  if (!live.stateDir) return;
  mkdirSync(live.stateDir, { recursive: true });
  const line = { at: new Date().toISOString(), kind: change.kind, id: change.id, outcome, digestBefore: before, digestAfter: after, problems };
  appendFileSync(join(live.stateDir, "config-changes.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function writeLiveConfig(live: LiveConfig, change: ConfigChange): void {
  const before = digest(live);
  try {
    applyChange(live, change);
  } catch (e) {
    if (e instanceof ConfigWriteError) audit(live, change, "refused", before, e.errors, null);
    throw e;
  }
  audit(live, change, "applied", before, [], digest(live));
}

function readRaw(path: string): Record<string, unknown> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}

function applyChange(live: LiveConfig, change: ConfigChange): void {
  const path = live.configPath;
  if (!path) throw new ConfigWriteError(["there is no operator file to write: create synapser.config.json first"]);
  if (change.kind === "agents") return applyAgent(live, path, change.id, change.value);
  const providers: Record<string, ProviderConfig> = { ...live.providers };
  const roles = { ...live.roles } as Record<Role, RoleConfig>;
  if (change.kind === "providers") {
    const problems = [...validateProviderConfig(change.id, change.value), ...metadataEndpointProblems(change.id, change.value)];
    if (problems.length) throw new ConfigWriteError(problems);
    providers[change.id] = change.value as ProviderConfig;
  } else {
    if (!(SYSTEM_ROLES as readonly string[]).includes(change.id)) throw new ConfigWriteError([`unknown role ${change.id}`]);
    roles[change.id as Role] = change.value as RoleConfig;
  }
  // The whole table must still hold together: a role must name a provider and a model that provider declares.
  try {
    systemModelConfig(providers, roles);
  } catch (e) {
    if (e instanceof ModelError) throw new ConfigWriteError(e.message.split("; "));
    throw e;
  }
  const raw = readRaw(path);
  raw[change.kind] = change.kind === "providers" ? providers : roles;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  replaceInPlace(live.providers, providers);
  replaceInPlace(live.roles, roles);
}

/**
 * An agent is validated by the loader itself: the candidate file, with the agent added or replaced, must load with no
 * problem. Only then does it replace the operator's file, and the live agent list changes in place.
 */
function applyAgent(live: LiveConfig, path: string, id: string, value: unknown): void {
  if (!live.profiles) throw new ConfigWriteError(["agents cannot change: this process holds no live agent list"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigWriteError(["an agent is an object"]);
  const raw = readRaw(path);
  const agents = Array.isArray(raw["agents"]) ? [...(raw["agents"] as unknown[])] : [];
  const entry = { ...(value as Record<string, unknown>), id };
  const at = agents.findIndex((a) => (a as { id?: unknown })?.id === id);
  if (at >= 0) agents[at] = entry;
  else agents.push(entry);
  const candidate = `${path}.candidate.${process.pid}`;
  writeFileSync(candidate, `${JSON.stringify({ ...raw, agents }, null, 2)}\n`, { mode: 0o600 });
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ path: candidate });
  } catch (e) {
    unlinkSync(candidate);
    if (e instanceof ConfigError) throw new ConfigWriteError(e.errors);
    throw e;
  }
  // A CLI agent that names an injected provider must name one the loaded file declares, with the model it declares.
  const injectionProblems = loaded.profiles.flatMap((p) => {
    if (p.injectProvider === undefined) return [];
    const provider = loaded.providers[p.injectProvider];
    if (!provider) return [`agent ${p.id}: unknown provider ${p.injectProvider}`];
    return provider.models.some((m) => m.id === p.model) ? [] : [`agent ${p.id}: model ${p.model} is not declared by provider ${p.injectProvider}`];
  });
  if (injectionProblems.length) {
    unlinkSync(candidate);
    throw new ConfigWriteError(injectionProblems);
  }
  renameSync(candidate, path);
  replaceInPlace(live.providers, loaded.providers);
  replaceInPlace(live.roles, loaded.roles);
  live.profiles.splice(0, live.profiles.length, ...loaded.profiles);
}
