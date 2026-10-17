// Plan 17 P17.8: the operator's providers, roles and agents change at run time (hot reload). A change is validated
// against the whole configuration first, then written atomically to the operator's file, then applied in place to the
// objects the runtime already holds, so every holder sees it without a restart. Nothing is written when validation fails.
// Every change, applied or refused, is appended to <stateDir>/config-changes.jsonl: the kind, the id, the outcome, the
// validator problems, and a digest of the table before and after. It never holds a key value.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../agents/profile.ts";
import { type ProviderConfig, type RoleConfig, SYSTEM_ROLES } from "../model/config.ts";
import type { Role } from "../model/types.ts";
import { ConfigError, loadConfig } from "./load.ts";
import { nativeWorkerProfileIds, type McpServerRegistration } from "../mcp/registry.ts";

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
  | { kind: "agents"; id: string; value: unknown }
  | { kind: "mcpServers"; id: string; value: unknown }
  | { kind: "mcpNativeReadOnlyProfiles"; id: string; value: unknown };

export interface LiveConfig {
  configPath?: string | null;
  /** Where the change log is kept: <stateDir>/config-changes.jsonl. Absent ⇒ no log (tests only). */
  stateDir?: string;
  providers: Record<string, ProviderConfig>;
  roles: Record<Role, RoleConfig>;
  /** The live agent list. Replaced in place, so the runtime's holders see new and changed agents. */
  profiles?: AgentProfile[];
  /** Operator-owned MCP registration list, replaced in place after full config validation. */
  mcpServers?: McpServerRegistration[];
}

/** Makes `target` equal to `next` without replacing the object, so every holder of `target` sees the change. */
export function replaceInPlace(target: object, next: object): void {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!Object.hasOwn(next, key)) delete t[key];
  for (const [key, value] of Object.entries(next)) t[key] = value;
}

const digest = (live: LiveConfig): string =>
  createHash("sha256").update(JSON.stringify({ providers: live.providers, roles: live.roles, profiles: live.profiles?.map((p) => p.id) ?? [], mcpServers: live.mcpServers ?? [] })).digest("hex").slice(0, 16);

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
  if (change.kind === "agents" && !live.profiles) throw new ConfigWriteError(["agents cannot change: this process holds no live agent list"]);
  if (change.kind === "mcpServers" && !live.mcpServers) throw new ConfigWriteError(["MCP servers cannot change: this process holds no live registry"]);
  if (change.kind === "mcpNativeReadOnlyProfiles" && (!live.mcpServers || !live.profiles)) throw new ConfigWriteError(["native MCP curation requires a live MCP registry and effective agent profiles"]);
  const raw = readRaw(path);
  if (change.kind === "agents") {
    if (!change.value || typeof change.value !== "object" || Array.isArray(change.value)) throw new ConfigWriteError(["an agent is an object"]);
    const agents = Array.isArray(raw["agents"]) ? [...(raw["agents"] as unknown[])] : [];
    const entry: Record<string, unknown> = { ...(change.value as Record<string, unknown>), id: change.id };
    const at = agents.findIndex((a) => (a as { id?: unknown })?.id === change.id);
    if (at >= 0) agents[at] = entry;
    else agents.push(entry);
    raw["agents"] = agents;
  } else if (change.kind === "providers") {
    raw["providers"] = { ...live.providers, [change.id]: change.value };
  } else if (change.kind === "roles") {
    if (!(SYSTEM_ROLES as readonly string[]).includes(change.id)) throw new ConfigWriteError([`unknown role ${change.id}`]);
    raw["roles"] = { ...live.roles, [change.id]: change.value };
  } else if (change.kind === "mcpServers") {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(change.id)) throw new ConfigWriteError(["MCP server id is invalid"]);
    if (!change.value || typeof change.value !== "object" || Array.isArray(change.value)) throw new ConfigWriteError(["an MCP server registration is an object"]);
    const servers = Array.isArray(raw["mcpServers"]) ? [...(raw["mcpServers"] as unknown[])] : [];
    const entry: Record<string, unknown> = { ...(change.value as Record<string, unknown>), id: change.id };
    const at = servers.findIndex((server) => (server as { id?: unknown })?.id === change.id);
    // The general registration editor intentionally does not own this separate native-worker grant.
    // Existing grants are preserved regardless of the full-record payload; new grants must use the dedicated path.
    if (at < 0 && Object.hasOwn(entry, "nativeReadOnlyProfiles")) {
      throw new ConfigWriteError(["nativeReadOnlyProfiles can only be changed through dedicated native MCP curation"]);
    }
    if (at >= 0) {
      const old = servers[at] as Record<string, unknown>;
      if (Object.hasOwn(old, "nativeReadOnlyProfiles")) entry["nativeReadOnlyProfiles"] = old["nativeReadOnlyProfiles"];
      else delete entry["nativeReadOnlyProfiles"];
    }
    if (at >= 0) servers[at] = entry;
    else servers.push(entry);
    raw["mcpServers"] = servers;
  } else {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(change.id)) throw new ConfigWriteError(["MCP server id is invalid"]);
    const current = live.mcpServers!.find((server) => server.id === change.id);
    if (!current) throw new ConfigWriteError([`unknown MCP server ${change.id}`]);
    if (!current.enabled) throw new ConfigWriteError([`MCP server ${change.id} is disabled`]);
    if (!current.artifact) throw new ConfigWriteError([`MCP server ${change.id} has no pinned artifact`]);
    if (!change.value || typeof change.value !== "object" || Array.isArray(change.value) || Object.getPrototypeOf(change.value) !== Object.prototype) {
      throw new ConfigWriteError(["native MCP curation must be an object mapping profile ids to tool-name arrays"]);
    }
    const eligible = new Set(nativeWorkerProfileIds(live.profiles!));
    const map = change.value as Record<string, unknown>;
    const problems: string[] = [];
    for (const [profile, tools] of Object.entries(map)) {
      if (!eligible.has(profile)) problems.push(`profile ${profile} is not an enabled native writer worker`);
      if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
        problems.push(`profiles.${profile} must be a list of tool names`);
        continue;
      }
      const allowlist = current.profiles[profile] ?? [];
      for (const tool of tools as string[]) if (!allowlist.includes(tool)) problems.push(`profiles.${profile}.${tool} is not in the general MCP allowlist`);
    }
    if (problems.length) throw new ConfigWriteError(problems);
    const servers = Array.isArray(raw["mcpServers"]) ? [...(raw["mcpServers"] as unknown[])] : [];
    const at = servers.findIndex((server) => (server as { id?: unknown })?.id === change.id);
    if (at < 0) throw new ConfigWriteError([`MCP server ${change.id} is missing from the operator file`]);
    const entry = servers[at] as Record<string, unknown>;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ConfigWriteError([`MCP server ${change.id} entry is invalid`]);
    if (entry["enabled"] !== true) throw new ConfigWriteError([`MCP server ${change.id} is disabled in the operator file`]);
    if (!entry["artifact"]) throw new ConfigWriteError([`MCP server ${change.id} has no pinned artifact in the operator file`]);
    if (Object.keys(map).length === 0) delete entry["nativeReadOnlyProfiles"];
    else entry["nativeReadOnlyProfiles"] = map;
    servers[at] = entry;
    raw["mcpServers"] = servers;
  }
  commit(live, path, raw, change.kind === "agents", change.kind === "mcpServers" || change.kind === "mcpNativeReadOnlyProfiles");
}

/**
 * The one validator of the operator's file (plan 18 E4, H12.5): the candidate file, with the change in it, must load with no
 * problem, as the loader reads the operator's file at start. Only then does it replace the operator's file, and the live
 * tables change in place. An injected CLI agent must also name a provider the loaded file declares, with the model it declares.
 */
function commit(live: LiveConfig, path: string, raw: Record<string, unknown>, replaceAgents: boolean, replaceMcpServers: boolean): void {
  const candidate = `${path}.candidate.${process.pid}`;
  writeFileSync(candidate, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ path: candidate });
  } catch (e) {
    unlinkSync(candidate);
    if (e instanceof ConfigError) throw new ConfigWriteError(e.errors);
    throw e;
  }
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
  // Only an agent change replaces the live agent list; a provider or role change leaves it as it is.
  if (replaceAgents && live.profiles) live.profiles.splice(0, live.profiles.length, ...loaded.profiles);
  if (replaceMcpServers && live.mcpServers) live.mcpServers.splice(0, live.mcpServers.length, ...loaded.mcpServers);
}
