import { isAbsolute } from "node:path";
import { adapterOf } from "../agents/profile.ts";
import type { AgentProfile } from "../agents/profile-types.ts";

/** An operator-owned external MCP process. `command` is trusted executable code, not sandboxed by registration. */
export interface McpServerRegistration {
  id: string;
  enabled: boolean;
  /** Provenance locator only; registering an origin does not download or verify the executable. */
  origin: string;
  version: string;
  /** Absolute host runtime; pinned entrypoint is prepended, and argv values stay separate. */
  command: string;
  args: string[];
  /** Operator-imported package tree. Legacy entries can still be read but cannot be spawned without this pin. */
  artifact?: { digest: string; entrypoint: string };
  expectedServer: { name: string; version: string };
  /** Per-profile allowlist of tool names. A profile absent from this map has no tools enabled. */
  profiles: Record<string, string[]>;
  /** Explicit operator declaration that these tools are read-only and may be exposed to native workers. */
  nativeReadOnlyProfiles?: Record<string, string[]>;
}

/** Exact tool-level subset selected by a published recipe. This never grants access by itself. */
export interface McpToolSelection {
  serverId: string;
  toolName: string;
}

/** Runtime binding captured when a recipe request resolves against operator configuration. */
export interface McpToolBinding extends McpToolSelection {
  registrationDigest: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SECRET_MARKER = /(?:api[-_]?key|access[-_]?token|token|authorization|bearer|password|secret|credential)/i;
const FLOATING_VERSION = /^(?:latest|current|stable|main|master|\*)$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** Effective profiles allowed to receive explicitly curated native MCP tools. This is an authorization
 * boundary, not proof that any declared MCP tool is semantically read-only. */
export function nativeWorkerProfileIds(profiles: readonly AgentProfile[]): string[] {
  return profiles.filter((profile) => profile.enabled && adapterOf(profile) === "native" && profile.role === "writer" && profile.nativeRole === "worker").map((profile) => profile.id);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${at}.${key} is not allowed (unknown fields, environment variables and secrets are rejected)`);
  }
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return !url.username && !url.password && !url.search && !url.hash;
    if (url.protocol === "file:") return !url.search && !url.hash && (url.hostname === "" || url.hostname === "localhost") && url.pathname.startsWith("/");
    return false;
  } catch {
    return false;
  }
}

/** Validate strict operator config and bind every profile allowlist to a known profile. */
export function validateMcpServerRegistry(raw: unknown, knownProfiles: readonly string[], eligibleNativeProfiles: readonly string[] = []): { ok: true; servers: McpServerRegistration[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, errors: ["mcpServers must be an array"] };
  const known = new Set(knownProfiles);
  const eligibleNative = new Set(eligibleNativeProfiles);
  const seenIds = new Set<string>();
  const servers: McpServerRegistration[] = [];

  raw.forEach((entry, i) => {
    const at = `mcpServers[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    exactKeys(entry, ["id", "enabled", "origin", "version", "command", "args", "artifact", "expectedServer", "profiles", "nativeReadOnlyProfiles"], at, errors);

    const id = entry["id"];
    if (typeof id !== "string" || !ID.test(id)) errors.push(`${at}.id must match [a-z0-9][a-z0-9_-]*`);
    else if (seenIds.has(id)) errors.push(`${at}.id "${id}" is duplicated`);
    else seenIds.add(id);

    const enabled = entry["enabled"];
    if (typeof enabled !== "boolean") errors.push(`${at}.enabled must be explicitly true or false`);

    const origin = entry["origin"];
    if (!validOrigin(origin)) errors.push(`${at}.origin must be an HTTPS or absolute file URI without credentials, query, or fragment`);

    const version = entry["version"];
    if (typeof version !== "string" || version.trim() !== version || version.length === 0 || version.length > 128 || FLOATING_VERSION.test(version)) errors.push(`${at}.version must be a non-floating version label`);

    const command = entry["command"];
    if (typeof command !== "string" || !isAbsolute(command) || command.includes("\0")) errors.push(`${at}.command must be an absolute executable path`);

    const args = entry["args"];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) errors.push(`${at}.args must be an array of individual strings`);
    else if (args.some((arg) => SECRET_MARKER.test(arg))) errors.push(`${at}.args contains a common credential marker; credential references are not supported`);

    const artifact = entry["artifact"];
    let pinnedArtifact: McpServerRegistration["artifact"];
    if (artifact !== undefined) {
      if (!isObject(artifact)) errors.push(`${at}.artifact must contain a SHA-256 tree digest and relative entrypoint`);
      else {
        exactKeys(artifact, ["digest", "entrypoint"], `${at}.artifact`, errors);
        if (typeof artifact["digest"] !== "string" || !SHA256.test(artifact["digest"])) errors.push(`${at}.artifact.digest must be a sha256:<lowercase-hex> tree digest`);
        const entrypoint = artifact["entrypoint"];
        if (typeof entrypoint !== "string" || entrypoint.length === 0 || entrypoint.startsWith("/") || entrypoint.includes("\\") ||
          entrypoint.split("/").some((part) => part.length === 0 || part === "." || part === "..") || entrypoint.includes("\0")) {
          errors.push(`${at}.artifact.entrypoint must be a normalized relative POSIX path`);
        }
        if (typeof artifact["digest"] === "string" && SHA256.test(artifact["digest"]) && typeof entrypoint === "string" &&
          entrypoint.length > 0 && !entrypoint.startsWith("/") && !entrypoint.includes("\\") &&
          !entrypoint.split("/").some((part) => part.length === 0 || part === "." || part === "..") && !entrypoint.includes("\0")) {
          pinnedArtifact = { digest: artifact["digest"], entrypoint };
        }
      }
    }

    const expected = entry["expectedServer"];
    let expectedServer: { name: string; version: string } | undefined;
    if (!isObject(expected)) errors.push(`${at}.expectedServer must contain exact name and version`);
    else {
      exactKeys(expected, ["name", "version"], `${at}.expectedServer`, errors);
      if (typeof expected["name"] !== "string" || expected["name"].length === 0 || expected["name"].trim() !== expected["name"]) errors.push(`${at}.expectedServer.name must be an exact non-empty name`);
      if (typeof expected["version"] !== "string" || expected["version"].length === 0 || expected["version"].trim() !== expected["version"]) errors.push(`${at}.expectedServer.version must be an exact non-empty version`);
      if (typeof expected["name"] === "string" && typeof expected["version"] === "string") expectedServer = { name: expected["name"], version: expected["version"] };
    }

    const profiles = entry["profiles"];
    const allowlists: Record<string, string[]> = {};
    if (!isObject(profiles)) errors.push(`${at}.profiles must map profile ids to allowed tool-name arrays`);
    else {
      for (const [profile, tools] of Object.entries(profiles)) {
        if (!PROFILE_ID.test(profile)) errors.push(`${at}.profiles key "${profile}" is not a profile id`);
        else if (!known.has(profile)) errors.push(`${at}.profiles references unknown profile "${profile}"`);
        if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !TOOL_NAME.test(tool))) {
          errors.push(`${at}.profiles.${profile} must be an array of valid tool names`);
          continue;
        }
        const duplicates = tools.filter((tool, index) => tools.indexOf(tool) !== index);
        if (duplicates.length) errors.push(`${at}.profiles.${profile} has duplicate tool name(s): ${[...new Set(duplicates)].join(", ")}`);
        allowlists[profile] = [...tools] as string[];
      }
    }

    const rawNativeReadOnly = entry["nativeReadOnlyProfiles"];
    const nativeReadOnlyProfiles: Record<string, string[]> = {};
    if (rawNativeReadOnly !== undefined) {
      if (!isObject(rawNativeReadOnly)) errors.push(`${at}.nativeReadOnlyProfiles must map native profile ids to explicitly read-only tool-name arrays`);
      else {
        for (const [profile, tools] of Object.entries(rawNativeReadOnly)) {
          if (!PROFILE_ID.test(profile)) errors.push(`${at}.nativeReadOnlyProfiles key "${profile}" is not a profile id`);
          else if (!known.has(profile)) errors.push(`${at}.nativeReadOnlyProfiles references unknown profile "${profile}"`);
          else if (!eligibleNative.has(profile)) errors.push(`${at}.nativeReadOnlyProfiles profile "${profile}" is not an enabled native writer worker`);
          if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !TOOL_NAME.test(tool))) {
            errors.push(`${at}.nativeReadOnlyProfiles.${profile} must be an array of valid tool names`);
            continue;
          }
          const duplicates = tools.filter((tool, index) => tools.indexOf(tool) !== index);
          if (duplicates.length) errors.push(`${at}.nativeReadOnlyProfiles.${profile} has duplicate tool name(s): ${[...new Set(duplicates)].join(", ")}`);
          const allowedForProfile = allowlists[profile] ?? [];
          for (const tool of tools) if (!allowedForProfile.includes(tool as string)) errors.push(`${at}.nativeReadOnlyProfiles.${profile}.${String(tool)} must also be in the general profile allowlist`);
          nativeReadOnlyProfiles[profile] = [...tools] as string[];
        }
      }
    }

    if (typeof id === "string" && ID.test(id) && typeof enabled === "boolean" && validOrigin(origin) && typeof version === "string" && version.trim() === version && version.length > 0 && version.length <= 128 && typeof command === "string" && isAbsolute(command) && !command.includes("\0") && Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0") && !SECRET_MARKER.test(arg)) && expectedServer && isObject(profiles)) {
      servers.push({ id, enabled, origin, version, command, args: [...args] as string[], ...(pinnedArtifact ? { artifact: pinnedArtifact } : {}), expectedServer, profiles: allowlists, ...(Object.keys(nativeReadOnlyProfiles).length ? { nativeReadOnlyProfiles } : {}) });
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, servers };
}
