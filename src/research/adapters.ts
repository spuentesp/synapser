// The three implementations of ResearchPort: Tavily (fetch, no SDK), Replay (recorded results, for
// CI and a reproducible demo) and Null (research disabled: private repositories).

import { createHash, randomUUID } from "node:crypto";
import { ResearchError, type ResearchContext, type ResearchHit, type ResearchPort, type ResearchQuery, type ResearchResult } from "./types.ts";

const MAX_CONTENT = 1500;
const DEFAULT_BASE = "https://api.tavily.com";

export interface TavilyOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class TavilyResearch implements ResearchPort {
  readonly provider = "tavily";
  readonly #o: TavilyOptions;
  constructor(o: TavilyOptions) {
    if (!o.apiKey) throw new ResearchError("AUTH", "no Tavily API key configured");
    this.#o = o;
  }

  async search(q: ResearchQuery, _ctx: ResearchContext): Promise<ResearchResult> {
    const f = this.#o.fetch ?? fetch;
    const started = Date.now();
    const body = {
      query: q.query,
      search_depth: q.depth,
      max_results: Math.max(1, Math.min(q.maxResults, 10)),
      // we keep SOURCES, never another model's summary of them
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
      ...(q.includeDomains?.length ? { include_domains: q.includeDomains } : {}),
      ...(q.excludeDomains?.length ? { exclude_domains: q.excludeDomains } : {}),
    };
    let res: Response;
    try {
      res = await f(`${(this.#o.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "")}/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 20_000),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ResearchError("TIMEOUT", "Tavily did not answer in time");
      throw new ResearchError("UNAVAILABLE", this.#scrub(String((e as Error).message)));
    }
    if (!res.ok) {
      const detail = this.#scrub((await res.text().catch(() => "")).slice(0, 200));
      if (res.status === 401 || res.status === 403) throw new ResearchError("AUTH", `HTTP ${res.status}`);
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        throw new ResearchError("RATE_LIMITED", "HTTP 429", Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
      }
      if (res.status === 400 || res.status === 422) throw new ResearchError("BAD_REQUEST", `HTTP ${res.status} ${detail}`);
      throw new ResearchError("UNAVAILABLE", `HTTP ${res.status}`);
    }
    let json: { results?: { url?: unknown; title?: unknown; content?: unknown; score?: unknown }[]; usage?: { credits?: unknown } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ResearchError("UNAVAILABLE", "Tavily returned a body that is not JSON");
    }
    const results: ResearchHit[] = (json.results ?? [])
      .filter((r) => typeof r.url === "string")
      .map((r) => ({
        url: String(r.url),
        title: typeof r.title === "string" ? r.title.slice(0, 200) : "",
        content: typeof r.content === "string" ? r.content.slice(0, MAX_CONTENT) : "",
        score: typeof r.score === "number" ? r.score : 0,
      }));
    const credits = json.usage?.credits;
    return { callId: `rc-${randomUUID()}`, results, creditsUsed: typeof credits === "number" ? credits : null, latencyMs: Date.now() - started, cached: false };
  }

  #scrub(s: string): string {
    return s.split(this.#o.apiKey).join("***");
  }
}

export const queryKey = (q: ResearchQuery): string =>
  createHash("sha256")
    .update(JSON.stringify([q.query.trim().toLowerCase(), q.depth, q.maxResults, [...(q.includeDomains ?? [])].sort(), [...(q.excludeDomains ?? [])].sort()]))
    .digest("hex");

/** Answers from a fixed table; a query that was never recorded is UNAVAILABLE, not invented. */
export class ReplayResearch implements ResearchPort {
  readonly provider = "replay";
  readonly #table: Map<string, ResearchHit[]>;
  constructor(entries: readonly { query: ResearchQuery; results: ResearchHit[] }[]) {
    this.#table = new Map(entries.map((e) => [queryKey(e.query), e.results]));
  }
  async search(q: ResearchQuery): Promise<ResearchResult> {
    const hit = this.#table.get(queryKey(q));
    if (!hit) throw new ResearchError("UNAVAILABLE", "no recorded result for this query");
    return { callId: `rc-${randomUUID()}`, results: hit, creditsUsed: 0, latencyMs: 0, cached: false };
  }
}

export class NullResearch implements ResearchPort {
  readonly provider = "none";
  async search(): Promise<ResearchResult> {
    throw new ResearchError("DISABLED", "research is disabled for this run");
  }
}
