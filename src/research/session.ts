// One run's research access: guard → budget → cache → provider, and EVERY outcome on the ledger.
// A refused query is recorded by hash only (its text may be the very thing the guard caught).

import { createHash, randomUUID } from "node:crypto";
import type { Journal } from "../journal/journal.ts";
import { queryKey } from "./adapters.ts";
import type { QueryGuard } from "./guard.ts";
import { ResearchError, type ResearchContext, type ResearchPort, type ResearchQuery, type ResearchResult } from "./types.ts";

export interface ResearchLimits {
  perTask: number;
  perMission: number;
}

export class ResearchSession {
  readonly #port: ResearchPort;
  readonly #journal: Journal;
  readonly #runId: string;
  readonly #guard: QueryGuard;
  readonly #limits: ResearchLimits;
  readonly #cache = new Map<string, ResearchResult>();
  readonly #perTask = new Map<string, number>();
  #total = 0;

  constructor(o: { port: ResearchPort; journal: Journal; runId: string; guard: QueryGuard; limits?: Partial<ResearchLimits> }) {
    this.#port = o.port;
    this.#journal = o.journal;
    this.#runId = o.runId;
    this.#guard = o.guard;
    this.#limits = { perTask: 5, perMission: 20, ...(o.limits ?? {}) };
  }

  get provider(): string {
    return this.#port.provider;
  }

  async search(q: ResearchQuery, ctx: Omit<ResearchContext, "runId">): Promise<ResearchResult> {
    const startedAt = Date.now();
    const taskId = ctx.taskId ?? null;
    const params = { depth: q.depth, maxResults: q.maxResults, includeDomains: q.includeDomains ?? [], excludeDomains: q.excludeDomains ?? [] };
    const sha = createHash("sha256").update(q.query).digest("hex");
    const record = (r: { callId: string; query: string | null; latencyMs: number | null; credits: number | null; cached: boolean; blob: string | null; error: string | null; urls: string[] }) =>
      this.#journal.tx((t) =>
        t.insertResearchCall({
          callId: r.callId, runId: this.#runId, taskId, role: ctx.role, provider: this.#port.provider, query: r.query, querySha256: sha,
          params, startedAt, latencyMs: r.latencyMs, creditsUsed: r.credits, cached: r.cached, resultBlob: r.blob, error: r.error, urls: r.urls,
        }),
      );
    const refuse = (code: ResearchError["code"], msg: string, storeQuery: boolean): never => {
      record({ callId: `rc-${randomUUID()}`, query: storeQuery ? q.query : null, latencyMs: 0, credits: null, cached: false, blob: null, error: `${code}: ${msg}`, urls: [] });
      throw new ResearchError(code, msg);
    };

    const verdict = this.#guard.check(q.query);
    if (!verdict.ok) refuse("GUARD", `${verdict.reason}: ${verdict.detail}`, false);
    if (this.#total >= this.#limits.perMission) refuse("BUDGET", `mission limit of ${this.#limits.perMission} searches reached`, true);
    if (taskId && (this.#perTask.get(taskId) ?? 0) >= this.#limits.perTask) refuse("BUDGET", `task limit of ${this.#limits.perTask} searches reached`, true);

    const key = queryKey(q);
    const hit = this.#cache.get(key);
    if (hit) {
      const callId = `rc-${randomUUID()}`;
      record({ callId, query: q.query, latencyMs: 0, credits: 0, cached: true, blob: this.#blob(hit), error: null, urls: hit.results.map((r) => r.url) });
      return { ...hit, callId, cached: true, latencyMs: 0, creditsUsed: 0 };
    }

    this.#total++;
    if (taskId) this.#perTask.set(taskId, (this.#perTask.get(taskId) ?? 0) + 1);
    let res: ResearchResult;
    try {
      res = await this.#withRetry(() => this.#port.search(q, { runId: this.#runId, ...(taskId ? { taskId } : {}), role: ctx.role }));
    } catch (e) {
      const err = e instanceof ResearchError ? e : new ResearchError("UNAVAILABLE", String((e as Error).message));
      record({ callId: `rc-${randomUUID()}`, query: q.query, latencyMs: Date.now() - startedAt, credits: null, cached: false, blob: null, error: `${err.code}: ${err.message}`, urls: [] });
      throw err;
    }
    this.#cache.set(key, res);
    record({ callId: res.callId, query: q.query, latencyMs: res.latencyMs, credits: res.creditsUsed, cached: false, blob: this.#blob(res), error: null, urls: res.results.map((r) => r.url) });
    return res;
  }

  #blob(r: ResearchResult): string {
    return this.#journal.artifacts.put(Buffer.from(JSON.stringify(r.results), "utf8"));
  }

  /** One retry, only for what a retry can fix, honouring Retry-After up to a small cap. */
  async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResearchError && (e.code === "RATE_LIMITED" || e.code === "UNAVAILABLE" || e.code === "TIMEOUT")) {
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs ?? 400, 5000)));
        return await fn();
      }
      throw e;
    }
  }
}
