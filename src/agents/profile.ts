// Agent profiles: a declarative description of HOW to invoke one agent CLI (design: "toolbox").
// A profile is data, validated by control; a model may choose among profiles but cannot edit them.

import { capabilitiesForAdapter, isAdapterId } from "./capabilities.ts";
import type { AdapterId, AgentProfile, AgentRole, Tier } from "./profile-types.ts";
export type { AdapterId, AgentProfile, AgentRole, AgentPermissions, Tier } from "./profile-types.ts";

/** What the agent is for: cheap = one-shot chores, standard = building, advanced = research/review/hard calls. */
export const TIERS: readonly Tier[] = ["cheap", "standard", "advanced"];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
/** How a profile is executed. New implementations (e.g. "orca") plug in behind the AgentRunner port. */

/** Profiles for the CLIs found and probed on this host (13 oct 2026). */
export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    id: "nemotron-worker",
    tier: "cheap",
    description: "Native loop on Token Factory (model role: worker); no filesystem, no shell",
    role: "writer",
    adapter: "native",
    argv: [],
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "tokenfactory",
    nativeRole: "worker",
    parser: "codex-jsonl", // unused by the native adapter
    timeoutMs: 600_000,
    tags: ["code", "tests", "worker", "nvidia"],
    enabled: true,
  },
  {
    id: "nemotron-repair",
    tier: "standard",
    description: "Native loop on Token Factory (model role: repair)",
    role: "writer",
    adapter: "native",
    argv: [],
    model: "nvidia/nemotron-3-super-120b-a12b",
    provider: "tokenfactory",
    nativeRole: "repair",
    parser: "codex-jsonl",
    timeoutMs: 600_000,
    tags: ["repair", "nvidia"],
    enabled: true,
  },
  {
    id: "claude-sonnet-writer",
    tier: "standard",
    description: "Claude Code (Sonnet) editing in an isolated copy; no shell",
    role: "writer",
    adapter: "claude-code",
    homeOverlay: [".claude", ".claude.json"],
    argv: [],
    model: "sonnet",
    permissions: { allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"] },
    maxBudgetUsd: 1,
    parser: "claude-json",
    timeoutMs: 300_000,
    tags: ["code", "refactor", "tests"],
    enabled: true,
  },
  {
    id: "claude-opus-advisor",
    tier: "advanced",
    description: "Claude Code (Opus) read-only review/advice",
    role: "advisor",
    adapter: "claude-code",
    homeOverlay: [".claude", ".claude.json"],
    argv: [],
    model: "opus",
    permissions: { allowedTools: ["Read", "Glob", "Grep"] },
    maxBudgetUsd: 2,
    parser: "claude-json",
    timeoutMs: 300_000,
    tags: ["review", "design", "advice"],
    enabled: true,
  },
  {
    id: "codex-writer",
    tier: "standard",
    description: "Codex CLI, workspace-write sandbox, in an isolated copy",
    role: "writer",
    adapter: "codex",
    argv: [],
    permissions: { mode: "workspace-write" },
    parser: "codex-jsonl",
    timeoutMs: 300_000,
    tags: ["code", "tests"],
    enabled: true,
  },
  {
    id: "codex-advisor",
    tier: "advanced",
    description: "Codex CLI, read-only sandbox",
    role: "advisor",
    adapter: "codex",
    argv: [],
    permissions: { mode: "read-only" },
    parser: "codex-jsonl",
    timeoutMs: 300_000,
    tags: ["review", "advice"],
    enabled: true,
  },
  {
    id: "kimi-writer",
    tier: "cheap",
    description: "Kimi Code (configured model: mimo-v2.6-pro) in an isolated copy. -p mode edits AND runs Bash without prompting: isolation is by copy only, not by capability",
    role: "writer",
    adapter: "kimi",
    argv: [],
    permissions: { mode: "default" },
    parser: "kimi-stream",
    timeoutMs: 300_000,
    tags: ["code", "worker"],
    enabled: true,
  },
  {
    id: "mimo-writer",
    tier: "cheap",
    description: "MiMo Code CLI",
    role: "writer",
    adapter: "mimo",
    argv: [],
    permissions: { mode: "default" },
    parser: "mimo-json",
    timeoutMs: 300_000,
    tags: ["code", "worker"],
    enabled: false,
    disabledReason: "provider returned 402 Insufficient account balance during the 13 oct spike",
  },
];

export const adapterOf = (p: AgentProfile): AdapterId => p.adapter ?? "cli-oneshot";

export function validateProfile(p: AgentProfile): string[] {
  // Total (plan 18 H3.3): any input yields problems, never an exception.
  if (!p || typeof p !== "object") return ["profile must be an object"];
  const errs: string[] = [];
  if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.id)) errs.push(`id ${JSON.stringify(p.id)} is not a slug`);
  if (adapterOf(p) === "cli-oneshot" || adapterOf(p) === "generic-cli") {
    const argv: unknown[] = Array.isArray(p.argv) ? p.argv : [];
    if (!Array.isArray(p.argv) || argv.length === 0 || typeof argv[0] !== "string" || /\s/.test(argv[0])) errs.push("argv[0] must be a program name without spaces (no shell strings)");
    if (!argv.some((a) => typeof a === "string" && a.includes("{prompt}"))) errs.push("argv must contain {prompt}");
  }
  if (adapterOf(p) === "generic-cli" && p.parser !== "plain") errs.push("generic-cli always uses the plain parser");
  const adapter = adapterOf(p);
  if (!isAdapterId(adapter)) return [...errs, `adapter ${String(adapter)} is not supported`];
  const capabilities = capabilitiesForAdapter(adapter);
  if (!capabilities.toolAllowlist && (p.permissions?.allowedTools !== undefined || p.permissions?.disallowedTools !== undefined)) {
    errs.push(`${adapter} does not support allowedTools or disallowedTools`);
  }
  if (capabilities.permissionModes.length === 0 && p.permissions?.mode !== undefined) {
    errs.push(`${adapter} does not support a named permission mode`);
  }
  if (adapterOf(p) === "claude-code") {
    if (!p.model) errs.push("a claude-code profile needs a model");
    for (const [field, tools] of [["allowedTools", p.permissions?.allowedTools], ["disallowedTools", p.permissions?.disallowedTools]] as const) {
      if (tools?.some((tool) => !tool || tool.includes(","))) errs.push(`claude-code ${field} entries must be non-empty and contain no commas`);
    }
  }
  if (p.permissions?.mode !== undefined && capabilities.permissionModes.length > 0 && !capabilities.permissionModes.includes(p.permissions.mode)) {
    errs.push(`${adapter} permission mode must be one of ${capabilities.permissionModes.join(", ")}`);
  }
  if (p.maxBudgetUsd !== undefined && !capabilities.budgetFlag) {
    errs.push(`${adapter} has no per-run USD budget flag`);
  }
  if (p.maxBudgetUsd !== undefined && (!Number.isFinite(p.maxBudgetUsd) || p.maxBudgetUsd <= 0 || p.maxBudgetUsd > 1_000)) errs.push("maxBudgetUsd must be greater than 0 and at most 1000");
  if (p.timeoutMs < 1000 || p.timeoutMs > 3_600_000) errs.push("timeoutMs out of range");
  if (p.tier !== undefined && !TIERS.includes(p.tier)) errs.push(`tier must be one of ${TIERS.join(", ")}`);
  if (p.provider && adapterOf(p) !== "native") errs.push("only a native agent may reference a provider");
  const injectable = ["claude-code", "codex", "kimi", "mimo"].includes(adapterOf(p));
  if (p.injectProvider !== undefined) {
    if (!injectable) errs.push("injectProvider is only valid for claude-code, codex, kimi or mimo");
    if (typeof p.injectProvider !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.injectProvider)) errs.push("injectProvider must be a lowercase slug");
    if (!p.model) errs.push("a CLI agent with injectProvider needs the model that provider declares");
  }
  if (p.provider && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.provider)) errs.push("provider must be a lowercase slug");
  if (adapterOf(p) === "native" && (!p.provider || !p.model)) errs.push("a native agent needs provider and model");
  if (adapterOf(p) !== "native" && (p.temperature !== undefined || p.nativeRole !== undefined)) errs.push("temperature and nativeRole are only valid for a native agent");
  if (p.temperature !== undefined && (!Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2)) errs.push("temperature must be between 0 and 2");
  if (p.nativeRole !== undefined && p.nativeRole !== "worker" && p.nativeRole !== "repair") errs.push('nativeRole must be "worker" or "repair"');
  if (p.role === "advisor" && p.argv.some((a) => /dangerously|bypass|yolo|workspace-write|--auto\b/.test(a))) errs.push("an advisor profile must not carry write/bypass flags");
  if (p.role === "advisor" && p.permissions?.mode === "bypassPermissions") errs.push("an advisor profile must not bypass permissions");
  if (p.role === "advisor" && p.permissions?.mode === "yolo") errs.push("an advisor profile must not use yolo permissions");
  if (p.role === "advisor" && p.permissions?.allowedTools?.some((tool) => /^(Bash|Edit|Write|NotebookEdit)$/.test(tool))) errs.push("an advisor profile must not allow write/shell tools");
  return errs;
}

export class ProfileRegistry {
  readonly #byId = new Map<string, AgentProfile>();
  constructor(profiles: readonly AgentProfile[] = BUILTIN_PROFILES) {
    for (const p of profiles) {
      const errs = validateProfile(p);
      if (errs.length) throw new Error(`invalid profile ${p.id}: ${errs.join("; ")}`);
      if (this.#byId.has(p.id)) throw new Error(`duplicate profile ${p.id}`);
      this.#byId.set(p.id, p);
    }
  }
  get(id: string): AgentProfile | undefined {
    return this.#byId.get(id);
  }
  list(opts: { role?: AgentRole; tag?: string; enabledOnly?: boolean } = {}): AgentProfile[] {
    return [...this.#byId.values()].filter((p) => (!opts.role || p.role === opts.role) && (!opts.tag || p.tags.includes(opts.tag)) && (!opts.enabledOnly || p.enabled));
  }
}
