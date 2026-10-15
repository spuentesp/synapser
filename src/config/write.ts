// Plan 17 P17.8 step 2: the operator's providers and roles change at run time (hot reload). A change is validated
// against the whole table first, then written atomically to the operator's file, then applied in place to the objects
// the runtime already holds, so every holder sees it without a restart. Nothing is written when validation fails.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { metadataEndpointProblems, type ProviderConfig, type RoleConfig, SYSTEM_ROLES, systemModelConfig, validateProviderConfig } from "../model/config.ts";
import { ModelError, type Role } from "../model/types.ts";

export class ConfigWriteError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

export type ConfigChange = { kind: "providers"; id: string; value: unknown } | { kind: "roles"; id: string; value: unknown };

export interface LiveConfig {
  configPath?: string | null;
  providers: Record<string, ProviderConfig>;
  roles: Record<Role, RoleConfig>;
}

/** Makes `target` equal to `next` without replacing the object, so every holder of `target` sees the change. */
function replaceInPlace(target: object, next: object): void {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!Object.hasOwn(next, key)) delete t[key];
  for (const [key, value] of Object.entries(next)) t[key] = value;
}

export function writeLiveConfig(live: LiveConfig, change: ConfigChange): void {
  const path = live.configPath;
  if (!path) throw new ConfigWriteError(["there is no operator file to write: create synapser.config.json first"]);
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
  const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  raw[change.kind] = change.kind === "providers" ? providers : roles;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  replaceInPlace(live.providers, providers);
  replaceInPlace(live.roles, roles);
}
