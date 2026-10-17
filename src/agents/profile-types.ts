import type { ParserId } from "./usage.ts";

export type AgentRole = "writer" | "advisor";
export type Tier = "cheap" | "standard" | "advanced";
export type AdapterId = "native" | "cli-oneshot" | "claude-code" | "codex" | "kimi" | "mimo" | "generic-cli" | "orca";

export interface AgentPermissions {
  mode?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

export interface AgentProfile {
  id: string;
  description: string;
  role: AgentRole;
  adapter?: AdapterId;
  argv: readonly string[];
  model?: string;
  provider?: string;
  injectProvider?: string;
  temperature?: number;
  nativeRole?: "worker" | "repair";
  parser: ParserId;
  timeoutMs: number;
  tags: readonly string[];
  env?: Readonly<Record<string, string>>;
  permissions?: AgentPermissions;
  maxBudgetUsd?: number;
  homeOverlay?: readonly string[];
  tier?: Tier;
  steerable?: "turn" | "attempt";
  pool?: string;
  enabled: boolean;
  disabledReason?: string;
}
