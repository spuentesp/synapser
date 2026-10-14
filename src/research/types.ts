// ResearchPort (plan 07 §3). The core never sees a vendor SDK or URL; swapping the search provider
// is one adapter. Everything a model reads through this port is untrusted DATA.

export type ResearchErrorCode = "RATE_LIMITED" | "UNAVAILABLE" | "TIMEOUT" | "AUTH" | "BAD_REQUEST" | "DISABLED" | "BUDGET" | "GUARD";

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: ResearchErrorCode, message: string, retryAfterMs: number | null = null) {
    super(`${code}: ${message}`);
    this.name = "ResearchError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ResearchQuery {
  query: string;
  maxResults: number;
  depth: "basic" | "advanced";
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

export interface ResearchHit {
  url: string;
  title: string;
  content: string;
  score: number;
}

export interface ResearchResult {
  callId: string;
  results: ResearchHit[];
  /** Credits the provider says it charged; null when it did not say. */
  creditsUsed: number | null;
  latencyMs: number;
  cached: boolean;
}

export interface ResearchContext {
  runId: string;
  taskId?: string;
  role: string;
}

export interface ResearchPort {
  readonly provider: string;
  search(q: ResearchQuery, ctx: ResearchContext): Promise<ResearchResult>;
}
