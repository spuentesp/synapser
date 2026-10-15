// OpenAI-compatible chat-completions adapter (Nebius Token Factory is configuration of this).
// Native fetch, no SDK. Responsibilities: role→model routing, error taxonomy, bounded retries
// that honor Retry-After, a global concurrency cap, budget reservation, accounting, and keeping
// the credential out of every error, log and recorded body.

import { randomUUID } from "node:crypto";
import { type ModelConfig, resolveApiKey } from "./config.ts";
import {
  type CallContext,
  type ChatMessage,
  type ModelCallRecord,
  ModelError,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ParsedToolCall,
  type RateLimitInfo,
  type Usage,
} from "./types.ts";

export interface ProviderDeps {
  config: ModelConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called once per `complete`, success or failure. Must not throw into the caller. */
  onCall?: (rec: ModelCallRecord) => void;
}

interface Attempt {
  status: number;
  body: any;
  headers: Headers;
  ms: number;
}

class Semaphore {
  #free: number;
  #waiters: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return;
    }
    await new Promise<void>((r) => this.#waiters.push(r));
  }
  release(): void {
    const w = this.#waiters.shift();
    if (w) w();
    else this.#free++;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OpenAICompatibleProvider implements ModelPort {
  readonly #d: ProviderDeps;
  readonly #sem: Semaphore;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(deps: ProviderDeps) {
    this.#d = deps;
    this.#sem = new Semaphore(deps.config.maxConcurrency);
    this.#fetch = deps.fetch ?? fetch;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#now = deps.now ?? Date.now;
  }

  async complete(req: ModelRequest, ctx: CallContext): Promise<ModelResponse> {
    const role = this.#d.config.roles[req.role];
    const provider = this.#d.config.providers[role.provider];
    if (!provider) throw new ModelError("CONFIG", `unknown provider ${role.provider}`);
    const apiKey = resolveApiKey(provider, this.#d.env);

    // Budget is consulted before anything leaves the process.
    const maxTokens = ctx.budget ? ctx.budget.reserve(req.maxTokens) : req.maxTokens;

    const callId = `mc-${randomUUID()}`;
    const startedAt = this.#now();
    const chain = [role.model, ...(role.fallbacks ?? [])];
    let retriesTotal = 0;
    let lastErr: ModelError | null = null;
    let lastRequest: unknown = null;
    let lastAttemptedModel = role.model;

    await this.#sem.acquire();
    try {
      for (let i = 0; i < chain.length; i++) {
        const model = chain[i] as string;
        lastAttemptedModel = model;
        const payload = this.#payload(req, model, role.temperature, maxTokens);
        lastRequest = payload;
        try {
          const { attempt, retries } = await this.#withRetries(provider.baseUrl, apiKey, payload);
          retriesTotal += retries;
          const res = this.#parse(attempt, {
            callId,
            requestedModel: role.model,
            fallbackUsed: i > 0,
            retries: retriesTotal,
            totalMs: this.#now() - startedAt,
          });
          ctx.budget?.record(res.usage);
          this.#emit({
            callId,
            runId: ctx.runId,
            taskId: ctx.taskId ?? null,
            role: req.role,
            requestedModel: role.model,
            attemptedModel: model,
            servedModel: res.servedModel,
            baseUrl: provider.baseUrl,
            startedAt,
            latencyMs: res.latencyMs,
            httpStatus: attempt.status,
            retries: retriesTotal,
            usage: res.usage,
            finishReason: res.finishReason,
            fallbackUsed: i > 0,
            error: null,
            request: payload,
            response: attempt.body,
          });
          return res;
        } catch (raw) {
          if (!(raw instanceof ModelError)) throw raw;
          const e = this.#scrub(raw, apiKey);
          lastErr = e;
          retriesTotal += (e as ModelError & { retries?: number }).retries ?? 0;
          // Only "this model is not there / is down" moves to the next model. Never auth,
          // bad request, rate limit or budget: those are not the model's fault.
          const eligible = e.kind === "UNAVAILABLE" || e.modelNotFound;
          if (!eligible || i === chain.length - 1) break;
        }
      }
    } finally {
      this.#sem.release();
    }
    ctx.budget?.recordFailedCall();
    const err = lastErr as ModelError;
    this.#emit({
      callId,
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      role: req.role,
      requestedModel: role.model,
      attemptedModel: lastAttemptedModel,
      servedModel: null,
      baseUrl: provider.baseUrl,
      startedAt,
      latencyMs: this.#now() - startedAt,
      httpStatus: err.status,
      retries: retriesTotal,
      usage: null,
      finishReason: null,
      fallbackUsed: false,
      error: `${err.kind}: ${err.message}`,
      request: lastRequest,
      response: null,
    });
    throw err;
  }

  // ---- internals ---------------------------------------------------------------------------

  #payload(req: ModelRequest, model: string, temperature: number, maxTokens: number): Record<string, unknown> {
    const p: Record<string, unknown> = { model, messages: req.messages, max_tokens: maxTokens, temperature };
    if (req.tools?.length) {
      p["tools"] = req.tools;
      const tc = req.toolChoice ?? "auto";
      p["tool_choice"] = typeof tc === "string" ? tc : { type: "function", function: { name: tc.name } };
    }
    if (req.responseSchema) {
      p["response_format"] = { type: "json_schema", json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema } };
    }
    return p;
  }

  async #withRetries(baseUrl: string, apiKey: string, payload: object): Promise<{ attempt: Attempt; retries: number }> {
    const max = this.#d.config.maxRetries;
    let retries = 0;
    for (let n = 0; ; n++) {
      let err: ModelError;
      try {
        const attempt = await this.#once(baseUrl, apiKey, payload);
        if (attempt.status >= 200 && attempt.status < 300) return { attempt, retries };
        err = this.#classify(attempt);
      } catch (e) {
        if (!(e instanceof ModelError)) throw e;
        err = e;
      }
      const retryable = err.kind === "RATE_LIMITED" || err.kind === "UNAVAILABLE" || err.kind === "TIMEOUT";
      if (!retryable || n >= max) {
        (err as ModelError & { retries?: number }).retries = retries;
        throw err;
      }
      retries++;
      const backoff = Math.min(8_000, 500 * 2 ** n) * (0.5 + this.#random() / 2);
      await this.#sleep(err.retryAfterMs ?? backoff);
    }
  }

  async #once(baseUrl: string, apiKey: string, payload: object): Promise<Attempt> {
    const t0 = this.#now();
    let res: Response;
    try {
      res = await this.#fetch(new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#d.config.timeoutMs),
        // P15 IC3: a redirect would move the prompts (and the key) to an address the document chose; refuse it
        redirect: "manual",
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new ModelError("TIMEOUT", `no response in ${this.#d.config.timeoutMs}ms`);
      // never include the underlying error text verbatim: some runtimes echo request headers
      throw new ModelError("UNAVAILABLE", `network error (${name ?? "unknown"})`);
    }
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _unparsed: text.slice(0, 200) };
    }
    return { status: res.status, body, headers: res.headers, ms: this.#now() - t0 };
  }

  #classify(a: Attempt): ModelError {
    const msg = String(a.body?.error?.message ?? a.body?.detail ?? a.body?._unparsed ?? `HTTP ${a.status}`).slice(0, 300);
    const code = String(a.body?.error?.code ?? "");
    const ra = a.headers.get("retry-after");
    const retryAfterMs = ra !== null && /^\d+(\.\d+)?$/.test(ra) ? Math.round(Number(ra) * 1000) : null;
    const s = a.status;
    if (s >= 300 && s < 400) return new ModelError("BAD_REQUEST", `HTTP ${s}: redirect refused, the request was not followed`, { status: s });
    if (s === 401 || s === 403) return new ModelError("AUTH", `HTTP ${s}`, { status: s });
    if (s === 429) return new ModelError("RATE_LIMITED", msg, { status: s, retryAfterMs });
    if (s === 408) return new ModelError("TIMEOUT", msg, { status: s });
    if (s >= 500) return new ModelError("UNAVAILABLE", `HTTP ${s}`, { status: s, retryAfterMs });
    if (/context|too long|maximum.*tokens|max_tokens/i.test(`${msg} ${code}`)) {
      return new ModelError("CONTEXT_EXCEEDED", msg, { status: s });
    }
    const notFound = s === 404 || /model.*(not found|does not exist|unknown)|not found.*model/i.test(`${msg} ${code}`);
    return new ModelError("BAD_REQUEST", msg, { status: s, modelNotFound: notFound });
  }

  #parse(
    a: Attempt,
    meta: { callId: string; requestedModel: string; fallbackUsed: boolean; retries: number; totalMs: number },
  ): ModelResponse {
    const choice = a.body?.choices?.[0];
    const m = choice?.message;
    if (!m || typeof m !== "object") throw new ModelError("UNAVAILABLE", "response has no choices[0].message", { status: a.status });
    const toolCalls: ParsedToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc: any, i: number) => {
      const raw = typeof tc?.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {});
      let args: unknown = null;
      let argsValid = false;
      try {
        args = JSON.parse(raw);
        argsValid = typeof args === "object" && args !== null && !Array.isArray(args);
      } catch {
        /* invalid JSON from the model: reported, not thrown */
      }
      return { id: String(tc?.id ?? `call_${i}`), name: String(tc?.function?.name ?? ""), argumentsRaw: raw, args: argsValid ? args : null, argsValid };
    });
    const content = typeof m.content === "string" ? m.content : null;
    const reasoningRaw = m.reasoning_content ?? m.reasoning;
    const usage: Usage = {
      promptTokens: Number(a.body?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(a.body?.usage?.completion_tokens ?? 0),
      reasoningTokens:
        typeof a.body?.usage?.completion_tokens_details?.reasoning_tokens === "number"
          ? a.body.usage.completion_tokens_details.reasoning_tokens
          : null,
    };
    const h = a.headers;
    const num = (k: string) => {
      const v = h.get(k);
      return v !== null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
    };
    const rateLimit: RateLimitInfo = {
      ...(num("x-ratelimit-limit-requests") !== undefined ? { limitRequests: num("x-ratelimit-limit-requests") as number } : {}),
      ...(num("x-ratelimit-limit-tokens") !== undefined ? { limitTokens: num("x-ratelimit-limit-tokens") as number } : {}),
      ...(num("x-ratelimit-remaining-requests") !== undefined ? { remainingRequests: num("x-ratelimit-remaining-requests") as number } : {}),
      ...(num("x-ratelimit-remaining-tokens") !== undefined ? { remainingTokens: num("x-ratelimit-remaining-tokens") as number } : {}),
      ...(h.get("x-ratelimit-over-limit") === "yes" ? { overLimit: true } : {}),
    };
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content,
      ...(Array.isArray(m.tool_calls) && m.tool_calls.length
        ? {
            tool_calls: toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.argumentsRaw },
            })),
          }
        : {}),
    };
    return {
      content,
      toolCalls,
      reasoning: typeof reasoningRaw === "string" && reasoningRaw.length ? reasoningRaw : null,
      assistantMessage,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      usage,
      requestedModel: meta.requestedModel,
      servedModel: String(a.body?.model ?? meta.requestedModel),
      fallbackUsed: meta.fallbackUsed,
      latencyMs: meta.totalMs,
      retries: meta.retries,
      rateLimit,
      callId: meta.callId,
    };
  }

  /** Defense in depth: an upstream that echoes our Authorization header must not leak it via errors. */
  #scrub(e: ModelError, apiKey: string): ModelError {
    if (!apiKey || !e.message.includes(apiKey)) return e;
    const clean = new ModelError(e.kind, e.message.replaceAll(apiKey, "***").replace(/^model [A-Z_]+: /, ""), {
      status: e.status,
      retryAfterMs: e.retryAfterMs,
      modelNotFound: e.modelNotFound,
    });
    (clean as ModelError & { retries?: number }).retries = (e as ModelError & { retries?: number }).retries ?? 0;
    return clean;
  }

  #emit(rec: ModelCallRecord): void {
    try {
      this.#d.onCall?.(rec);
    } catch {
      /* accounting must never break a call */
    }
  }
}

