// Canonical adapter capability declarations. The adapters, profile validator and orchestration
// catalog consume this same table so a permission mode cannot drift from the flags we emit.
import type { AdapterId, AgentProfile } from "./profile-types.ts";

export type SkillSupport = "native" | "prompt-prepend" | "none";
export type SkillMechanism = "native-dir" | "skills-dir-flag" | "prompt-prepend" | "none";

export interface AgentCapabilities {
  /** Whether this repository has a runner implementation, not merely an ID reserved for future use. */
  available: boolean;
  headless: boolean;
  structuredOutput: boolean;
  skills: SkillSupport;
  skillMechanism: SkillMechanism;
  /** The CLI can act as an MCP client; this does not mean Synapser injected a server. */
  mcp: boolean;
  /** External MCP configuration injection is not implemented until plan 19 P19.5. */
  mcpConfigInjection: boolean;
  toolAllowlist: boolean;
  permissionModes: readonly string[];
  budgetFlag: boolean;
  resume: boolean;
  /** Complete option surface emitted by a dedicated adapter (positional commands excluded). */
  cliFlags: readonly string[];
  /** Generic wrappers forward flags from the operator-owned profile instead of emitting their own. */
  profileDefinedFlags: boolean;
}

const cap = (value: AgentCapabilities): AgentCapabilities => Object.freeze(value);

export const ADAPTER_CAPABILITIES: Readonly<Record<AdapterId, AgentCapabilities>> = Object.freeze({
  native: cap({ available: true, headless: true, structuredOutput: true, skills: "prompt-prepend", skillMechanism: "prompt-prepend", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: [], budgetFlag: false, resume: false, cliFlags: [], profileDefinedFlags: false }),
  "cli-oneshot": cap({ available: true, headless: true, structuredOutput: false, skills: "none", skillMechanism: "none", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: [], budgetFlag: false, resume: false, cliFlags: [], profileDefinedFlags: true }),
  "claude-code": cap({ available: true, headless: true, structuredOutput: true, skills: "native", skillMechanism: "native-dir", mcp: true, mcpConfigInjection: false, toolAllowlist: true, permissionModes: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"], budgetFlag: true, resume: true, cliFlags: ["-p", "--output-format", "--strict-mcp-config", "--model", "--allowedTools", "--disallowedTools", "--permission-mode", "--max-budget-usd"], profileDefinedFlags: false }),
  codex: cap({ available: true, headless: true, structuredOutput: true, skills: "native", skillMechanism: "native-dir", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: ["read-only", "workspace-write"], budgetFlag: false, resume: true, cliFlags: ["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "-C", "-c", "-m"], profileDefinedFlags: false }),
  kimi: cap({ available: true, headless: true, structuredOutput: true, skills: "native", skillMechanism: "skills-dir-flag", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: ["default", "yolo", "plan"], budgetFlag: false, resume: true, cliFlags: ["-p", "--output-format", "--yolo", "--plan", "--skills-dir", "-m"], profileDefinedFlags: false }),
  mimo: cap({ available: true, headless: true, structuredOutput: true, skills: "native", skillMechanism: "native-dir", mcp: true, mcpConfigInjection: false, toolAllowlist: false, permissionModes: ["default", "yolo"], budgetFlag: false, resume: true, cliFlags: ["--format", "--pure", "--dir", "--model", "--dangerously-skip-permissions"], profileDefinedFlags: false }),
  "generic-cli": cap({ available: true, headless: true, structuredOutput: false, skills: "prompt-prepend", skillMechanism: "prompt-prepend", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: [], budgetFlag: false, resume: false, cliFlags: [], profileDefinedFlags: true }),
  orca: cap({ available: false, headless: false, structuredOutput: false, skills: "none", skillMechanism: "none", mcp: false, mcpConfigInjection: false, toolAllowlist: false, permissionModes: [], budgetFlag: false, resume: false, cliFlags: [], profileDefinedFlags: false }),
});

export function capabilitiesForAdapter(adapter: AdapterId): AgentCapabilities {
  return ADAPTER_CAPABILITIES[adapter];
}

export function isAdapterId(adapter: unknown): adapter is AdapterId {
  return typeof adapter === "string" && Object.hasOwn(ADAPTER_CAPABILITIES, adapter);
}

export interface EffectiveProfileCapabilities {
  available: boolean;
  execution: "native-loop" | "isolated-cli" | "configured-cli" | "remote";
  output: "structured" | "text";
  skills: SkillMechanism;
  mcpClient: boolean;
  mcpConfigInjection: boolean;
  permissionModes: readonly string[];
  permissionMode: string | null;
  toolAllowlist: boolean;
  role: AgentProfile["role"];
  budgetFlag: boolean;
  budgetUsd: number | null;
  timeoutMs: number;
  resume: boolean;
  steerable: AgentProfile["steerable"] | null;
  capabilityIds: readonly string[];
}

export function effectiveProfileCapabilities(profile: AgentProfile): EffectiveProfileCapabilities {
  const adapter = profile.adapter ?? "cli-oneshot";
  const declared = capabilitiesForAdapter(adapter);
  const capabilityIds = [
    ...(adapter === "native" ? ["execution.native"] : adapter === "orca" ? ["execution.remote"] : ["execution.cli"]),
    ...(declared.structuredOutput ? ["output.structured"] : ["output.text"]),
    ...(declared.skills === "native" ? ["skills.native"] : declared.skills === "prompt-prepend" ? ["skills.prompt-prepend"] : []),
    ...(declared.skillMechanism !== "none" ? ["skills.injectable"] : []),
    ...(declared.mcp ? ["mcp.client"] : []),
    ...(declared.mcpConfigInjection ? ["mcp.injected"] : []),
    ...(declared.budgetFlag ? ["budget.usd"] : []),
    ...(declared.resume ? ["resume"] : []),
    ...(declared.toolAllowlist ? ["permissions.tool-allowlist"] : []),
    ...(profile.permissions?.mode ? [`permissions.mode.${profile.permissions.mode}`] : []),
  ];
  return {
    available: declared.available,
    execution: adapter === "native" ? "native-loop" : adapter === "orca" ? "remote" : adapter === "cli-oneshot" || adapter === "generic-cli" ? "configured-cli" : "isolated-cli",
    output: declared.structuredOutput ? "structured" : "text",
    skills: declared.skillMechanism,
    mcpClient: declared.mcp,
    mcpConfigInjection: declared.mcpConfigInjection,
    permissionModes: declared.permissionModes,
    permissionMode: profile.permissions?.mode ?? null,
    toolAllowlist: declared.toolAllowlist,
    role: profile.role,
    budgetFlag: declared.budgetFlag,
    budgetUsd: declared.budgetFlag ? profile.maxBudgetUsd ?? null : null,
    timeoutMs: profile.timeoutMs,
    resume: declared.resume,
    steerable: profile.steerable ?? null,
    capabilityIds,
  };
}
