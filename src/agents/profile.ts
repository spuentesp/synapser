// Agent profiles: a declarative description of HOW to invoke one agent CLI (design: "toolbox").
// A profile is data, validated by control; a model may choose among profiles but cannot edit them.

import type { ParserId } from "./usage.ts";

export type AgentRole = "writer" | "advisor";
/** What the agent is for: cheap = one-shot chores, standard = building, advanced = research/review/hard calls. */
export type Tier = "cheap" | "standard" | "advanced";
export const TIERS: readonly Tier[] = ["cheap", "standard", "advanced"];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
/** How a profile is executed. New implementations (e.g. "orca") plug in behind the AgentRunner port. */
export type AdapterId = "native" | "cli-oneshot" | "claude-code" | "codex" | "kimi" | "mimo" | "generic-cli" | "orca";

export interface AgentPermissions {
  /** Adapter-specific named mode. The adapter validates and translates it to its CLI flag. */
  mode?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

export interface AgentProfile {
  id: string;
  description: string;
  role: AgentRole;
  /** Defaults to "cli-oneshot". */
  adapter?: AdapterId;
  /** cli-oneshot only. `{prompt}`, `{cwd}` and `{model}` are substituted. argv[0] is a program, never a shell string. */
  argv: readonly string[];
  /** native: the model ROLE in the model config ("worker" | "repair"); cli: informational. */
  model?: string;
  /** cli-oneshot only: how to read the tool's own events. */
  parser: ParserId;
  timeoutMs: number;
  /** Capability tags the orchestrator may match against a task. */
  tags: readonly string[];
  /** Extra environment entries. Our own credentials are NEVER inherited (see runner). */
  env?: Readonly<Record<string, string>>;
  /** Permission policy translated by the selected adapter, never interpolated as a shell string. */
  permissions?: AgentPermissions;
  /** Hard per-invocation CLI budget when the adapter supports one. */
  maxBudgetUsd?: number;
  /**
   * What the CLI needs from the real HOME to authenticate and keep its own settings (relative paths,
   * e.g. ".claude"). Everything else in HOME — ~/.ssh, ~/.gitconfig, ~/.config/gh, ~/.netrc — is NOT
   * visible to the agent: it runs with a scratch HOME (plan 13 §5.2).
   */
  homeOverlay?: readonly string[];
  /** Capability tier (plan 13 §7). Default `standard`. */
  tier?: Tier;
  /** How guidance can reach a running agent: between turns (`turn`) or only at its next attempt (`attempt`). */
  steerable?: "turn" | "attempt";
  /** Pool this agent belongs to (limits concurrency across its members). */
  pool?: string;
  /**
   * A native-loop agent backed by ANY OpenAI-compatible endpoint (another model, a local server).
   * `adapter` must be `native`. The key is read from the first set variable of `apiKeyEnv`.
   */
  endpoint?: { baseUrl: string; model: string; apiKeyEnv: readonly string[]; temperature?: number };
  /** Disabled profiles stay in the catalog (so the audit can name them) but are never scheduled. */
  enabled: boolean;
  disabledReason?: string;
}

/** Profiles for the CLIs found and probed on this host (13 oct 2026). */
export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    id: "nemotron-worker",
    tier: "cheap",
    description: "Native loop on Token Factory (model role: worker); no filesystem, no shell",
    role: "writer",
    adapter: "native",
    argv: [],
    model: "worker",
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
    model: "repair",
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
    homeOverlay: [".codex"],
    argv: ["codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write", "-C", "{cwd}", "{prompt}"],
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
    homeOverlay: [".codex"],
    argv: ["codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "{cwd}", "{prompt}"],
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
    homeOverlay: [".kimi", ".kimi-code"],
    argv: ["kimi", "-p", "{prompt}", "--output-format", "stream-json"],
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
    homeOverlay: [".mimo", ".mimocode"],
    argv: ["mimo", "run", "{prompt}", "--format", "json"],
    parser: "mimo-json",
    timeoutMs: 300_000,
    tags: ["code", "worker"],
    enabled: false,
    disabledReason: "provider returned 402 Insufficient account balance during the 13 oct spike",
  },
];

export const adapterOf = (p: AgentProfile): AdapterId => p.adapter ?? "cli-oneshot";

export function validateProfile(p: AgentProfile): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.id)) errs.push(`id ${JSON.stringify(p.id)} is not a slug`);
  if (adapterOf(p) === "cli-oneshot") {
    if (p.argv.length === 0 || /\s/.test(p.argv[0] ?? " ")) errs.push("argv[0] must be a program name without spaces (no shell strings)");
    if (!p.argv.some((a) => a.includes("{prompt}"))) errs.push("argv must contain {prompt}");
  }
  if (adapterOf(p) === "claude-code") {
    if (!p.model) errs.push("a claude-code profile needs a model");
    const modes = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
    if (p.permissions?.mode !== undefined && !modes.includes(p.permissions.mode)) errs.push(`claude-code permission mode must be one of ${modes.join(", ")}`);
    for (const [field, tools] of [["allowedTools", p.permissions?.allowedTools], ["disallowedTools", p.permissions?.disallowedTools]] as const) {
      if (tools?.some((tool) => !tool || tool.includes(","))) errs.push(`claude-code ${field} entries must be non-empty and contain no commas`);
    }
  }
  if (p.maxBudgetUsd !== undefined && (!Number.isFinite(p.maxBudgetUsd) || p.maxBudgetUsd <= 0 || p.maxBudgetUsd > 1_000)) errs.push("maxBudgetUsd must be greater than 0 and at most 1000");
  if (p.timeoutMs < 1000 || p.timeoutMs > 3_600_000) errs.push("timeoutMs out of range");
  if (p.tier !== undefined && !TIERS.includes(p.tier)) errs.push(`tier must be one of ${TIERS.join(", ")}`);
  if (p.endpoint) {
    if (adapterOf(p) !== "native") errs.push("an endpoint agent must use the native adapter");
    if (!/^https:\/\//.test(p.endpoint.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(p.endpoint.baseUrl)) errs.push("endpoint.baseUrl must be https (or loopback)");
    if (!p.endpoint.model || p.endpoint.apiKeyEnv.length === 0) errs.push("endpoint needs a model and at least one apiKeyEnv variable name");
  }
  if (p.role === "advisor" && p.argv.some((a) => /dangerously|bypass|yolo|workspace-write|--auto\b/.test(a))) errs.push("an advisor profile must not carry write/bypass flags");
  if (p.role === "advisor" && p.permissions?.mode === "bypassPermissions") errs.push("an advisor profile must not bypass permissions");
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
