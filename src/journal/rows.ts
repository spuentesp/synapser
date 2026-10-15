// The row and insert types of the journal (plan 01). Kept apart so the read side can use them without importing the
// journal's class; journal.ts re-exports every name, so existing imports are unchanged.

import type { Digest } from "../digest/file.ts";
import type { ActionState } from "./transitions.ts";

export interface NewAction {
  runId: string;
  actionId: string;
  taskId: string;
  actorOwner: string;
  incarnation: number;
  planRevision: number;
  requestDigest: Digest;
}

export interface NewActionFile {
  path: string;
  op: "create" | "replace" | "delete";
  beforeDigest: Digest | null;
  afterDigest: Digest | null;
  beforeMode: number | null;
  afterMode: number | null;
  beforeBlob: Digest | null;
  afterBlob: Digest | null;
  tmpName: string | null;
}

export interface ActionRow extends NewAction {
  state: ActionState;
  attempt: number;
  errorCode: string | null;
  receipt: unknown;
  registryCleanup: "CLEARED" | "UNVERIFIED" | null;
  fsCleanup: "NOT_ATTESTED";
  preparedAt: number;
  updatedAt: number;
}

export interface ActionFileRow extends NewActionFile {
  runId: string;
  actionId: string;
  progress: "PENDING" | "APPLIED";
  observedDigest: string | null;
}

export interface AgentRunInsert {
  agentRunId: string;
  runId: string;
  taskId: string | null;
  profileId: string;
  role: string;
  adapter: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  argv: string[];
  baseDigest: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  reason: string | null;
  sessionId: string | null;
  models: string[];
  usageProvenance: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  apiMs: number | null;
  networkIsolated: boolean;
  permissionDenials: number | null;
  promptBlob: string | null;
  stdoutBlob: string | null;
  stderrBlob: string | null;
  finalTextBlob: string | null;
  toolUse: Record<string, number> | null;
  skills?: { id: string; digest: string; mechanism: "native-dir" | "skills-dir-flag" | "prompt-prepend" }[];
  /** K4 (plan 17): the injected provider of this run, by name and endpoint only. Never a key value. */
  injection?: { provider: string; model: string; endpoint: string; keyVariable: string; protocol: string } | null;
  changes: { path: string; op: string; beforeDigest: string | null; afterDigest: string | null }[];
}

export interface ModelCallInsert {
  callId: string;
  runId: string;
  taskId: string | null;
  role: string;
  requestedModel: string;
  servedModel: string | null;
  baseUrl: string;
  startedAt: number;
  latencyMs: number | null;
  httpStatus: number | null;
  retries: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  fallbackUsed: boolean;
  costUsd: number | null;
  error: string | null;
  requestBlob: string | null;
  responseBlob: string | null;
}

export interface ChildRow {
  pid: number;
  kind: string;
  runId: string | null;
  taskId: string | null;
  /** Field 22 of /proc/<pid>/stat: identifies THIS process even if the pid is later reused. */
  procStartTicks: number;
  pgid: number;
  generation: number;
}

export interface SessionRow {
  actorOwner: string;
  incarnation: number;
  generation: number;
}

export interface EventRow {
  runId: string;
  seq: number;
  ts: number;
  entity: string;
  entityId: string;
  fromState: string | null;
  toState: string | null;
  data: unknown;
}

export type InsertOutcome =
  | { kind: "created" }
  | { kind: "duplicate"; state: ActionState; receipt: unknown }
  | { kind: "digest_conflict"; existingDigest: Digest };

export interface TransitionData {
  errorCode?: string | null;
  receipt?: unknown;
  registryCleanup?: "CLEARED" | "UNVERIFIED";
  /** Extra fields recorded on the event only. */
  event?: Record<string, unknown>;
  bumpAttempt?: boolean;
}

export interface ResearchCallInsert {
  callId: string;
  runId: string;
  taskId: string | null;
  role: string;
  provider: string;
  /** null when the query was refused by the guard: its text is not stored, only its hash. */
  query: string | null;
  querySha256: string;
  params: Record<string, unknown>;
  startedAt: number;
  latencyMs: number | null;
  creditsUsed: number | null;
  cached: boolean;
  resultBlob: string | null;
  error: string | null;
  urls: string[];
}

export interface ResearchCallRow {
  callId: string;
  taskId: string | null;
  role: string;
  provider: string;
  query: string | null;
  querySha256: string;
  startedAt: number;
  latencyMs: number | null;
  creditsUsed: number | null;
  cached: boolean;
  resultBlob: string | null;
  error: string | null;
  urls: string[];
}
