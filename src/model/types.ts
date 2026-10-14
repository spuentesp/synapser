// ModelPort (plan 06 §4). The core never sees a vendor SDK, a base URL or a model id:
// it asks for a ROLE and gets back a response plus everything needed to account for it.

export type Role = "supervisor" | "worker" | "repair" | "advisor" | "chat";

/**
 * Wire-format chat message. There is deliberately NO reasoning field here: model reasoning is
 * returned separately on ModelResponse and cannot be replayed into the history by construction.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ModelRequest {
  role: Role;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  /** JSON Schema for structured output (supervisor). */
  responseSchema?: { name: string; schema: object };
  /** Includes hidden reasoning tokens: size it for reasoning + answer. */
  maxTokens: number;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
  /** Parsed arguments, or null when the model produced invalid JSON. */
  args: unknown;
  argsValid: boolean;
}

export interface Usage {
  promptTokens: number;
  /** As billed: includes reasoning tokens. */
  completionTokens: number;
  reasoningTokens: number | null;
}

export interface RateLimitInfo {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  overLimit?: boolean;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  /** Hidden reasoning, for traces only. Never part of `assistantMessage`. */
  reasoning: string | null;
  /** Ready to append to the history (no reasoning). */
  assistantMessage: ChatMessage;
  finishReason: string | null;
  usage: Usage;
  requestedModel: string;
  servedModel: string;
  /** True when the primary model failed and a configured fallback answered. */
  fallbackUsed: boolean;
  latencyMs: number;
  retries: number;
  rateLimit: RateLimitInfo;
  callId: string;
}

export type ModelErrorKind =
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CONTEXT_EXCEEDED"
  | "BAD_REQUEST"
  | "AUTH"
  | "BUDGET"
  | "CONFIG";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly modelNotFound: boolean;
  constructor(
    kind: ModelErrorKind,
    message: string,
    extra: { status?: number | null; retryAfterMs?: number | null; modelNotFound?: boolean } = {},
  ) {
    super(`model ${kind}: ${message}`);
    this.name = "ModelError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.modelNotFound = extra.modelNotFound ?? false;
  }
}

export interface CallContext {
  runId: string;
  taskId?: string;
  budget?: import("./budget.ts").BudgetManager;
}

export interface ModelPort {
  complete(req: ModelRequest, ctx: CallContext): Promise<ModelResponse>;
}

/** What gets recorded per attempt-chain (one record per `complete` call, success or failure). */
export interface ModelCallRecord {
  callId: string;
  runId: string;
  taskId: string | null;
  role: Role;
  requestedModel: string;
  servedModel: string | null;
  baseUrl: string;
  startedAt: number;
  latencyMs: number;
  httpStatus: number | null;
  retries: number;
  usage: Usage | null;
  finishReason: string | null;
  fallbackUsed: boolean;
  error: string | null;
  /** Bodies WITHOUT credentials; the recorder decides where they are stored. */
  request: unknown;
  response: unknown;
}
