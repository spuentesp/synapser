// Agent profiles: a declarative description of HOW to invoke one agent CLI (design: "toolbox").
// A profile is data, validated by control; a model may choose among profiles but cannot edit them.

import type { ParserId } from "./usage.ts";

export type AgentRole = "writer" | "advisor";
/** How a profile is executed. New implementations (e.g. "orca") plug in behind the AgentRunner port. */
export type AdapterId = "native" | "cli-oneshot" | "orca";

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
  /** Disabled profiles stay in the catalog (so the audit can name them) but are never scheduled. */
  enabled: boolean;
  disabledReason?: string;
}

/** Profiles for the CLIs found and probed on this host (13 oct 2026). */
export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    id: "nemotron-worker",
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
    description: "Claude Code (Sonnet) editing in an isolated copy; no shell",
    role: "writer",
    argv: ["claude", "-p", "{prompt}", "--output-format", "json", "--model", "sonnet", "--allowedTools", "Read,Glob,Grep,Edit,Write", "--max-budget-usd", "1"],
    parser: "claude-json",
    timeoutMs: 300_000,
    tags: ["code", "refactor", "tests"],
    enabled: true,
  },
  {
    id: "claude-opus-advisor",
    description: "Claude Code (Opus) read-only review/advice",
    role: "advisor",
    argv: ["claude", "-p", "{prompt}", "--output-format", "json", "--model", "opus", "--allowedTools", "Read,Glob,Grep", "--max-budget-usd", "2"],
    parser: "claude-json",
    timeoutMs: 300_000,
    tags: ["review", "design", "advice"],
    enabled: true,
  },
  {
    id: "codex-writer",
    description: "Codex CLI, workspace-write sandbox, in an isolated copy",
    role: "writer",
    argv: ["codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write", "-C", "{cwd}", "{prompt}"],
    parser: "codex-jsonl",
    timeoutMs: 300_000,
    tags: ["code", "tests"],
    enabled: true,
  },
  {
    id: "codex-advisor",
    description: "Codex CLI, read-only sandbox",
    role: "advisor",
    argv: ["codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "{cwd}", "{prompt}"],
    parser: "codex-jsonl",
    timeoutMs: 300_000,
    tags: ["review", "advice"],
    enabled: true,
  },
  {
    id: "kimi-writer",
    description: "Kimi Code (configured model: mimo-v2.6-pro) in an isolated copy. -p mode edits AND runs Bash without prompting: isolation is by copy only, not by capability",
    role: "writer",
    argv: ["kimi", "-p", "{prompt}", "--output-format", "stream-json"],
    parser: "kimi-stream",
    timeoutMs: 300_000,
    tags: ["code", "worker"],
    enabled: true,
  },
  {
    id: "mimo-writer",
    description: "MiMo Code CLI",
    role: "writer",
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
  if (p.timeoutMs < 1000 || p.timeoutMs > 3_600_000) errs.push("timeoutMs out of range");
  if (p.role === "advisor" && p.argv.some((a) => /dangerously|bypass|yolo|workspace-write|--auto\b/.test(a))) errs.push("an advisor profile must not carry write/bypass flags");
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
