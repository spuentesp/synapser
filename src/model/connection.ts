// Provider connection test (plan 14 Q2.4). It lists what the endpoint serves and makes ONE minimal call.
// It is a diagnostic, not a model call: no retries, no budget, no ledger row; its usage and estimated cost
// come back in the report instead. The key travels only in the Authorization header of requests to the
// provider's own baseUrl. Redirects are refused, never followed, and upstream text is never echoed, so the
// report cannot carry the key even when an upstream reflects our headers.

import { declaredModelPrice, type ProviderConfig, resolveApiKey } from "./config.ts";
import type { Usage } from "./types.ts";

export interface ConnectionReport {
  ok: boolean;
  /** Why the test failed, in one line; null when it passed. Never contains the key. */
  error: string | null;
  /** The NAME of the environment variable the key was read from; null when none is set. */
  keyFrom: string | null;
  listing: { status: "served"; models: string[]; notListed: string[] } | { status: "unavailable"; detail: string };
  call: { model: string; ok: boolean; latencyMs: number; detail: string; usage: Usage | null; costUsd: number | null } | null;
}

export interface ConnectionOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Applies to each request. */
  timeoutMs?: number;
  /** The declared model to call; the first declared one by default. */
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function testProviderConnection(provider: ProviderConfig, o: ConnectionOptions = {}): Promise<ConnectionReport> {
  const env = o.env ?? process.env;
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keyFrom = provider.apiKeyEnv.find((name) => (env[name] ?? "").trim() !== "") ?? null;
  if (keyFrom === null) {
    return { ok: false, error: `no API key in environment (tried ${provider.apiKeyEnv.join(", ")})`, keyFrom: null, listing: { status: "unavailable", detail: "no API key" }, call: null };
  }
  const key = resolveApiKey(provider, env);
  const base = provider.baseUrl.endsWith("/") ? provider.baseUrl : `${provider.baseUrl}/`;
  const headers = { authorization: `Bearer ${key}` };

  const listed = await send(doFetch, new URL("models", base), { method: "GET", headers }, timeoutMs);
  const listing: ConnectionReport["listing"] =
    listed.ok && Array.isArray(listed.body?.data)
      ? served(provider, (listed.body.data as unknown[]).map((item) => (item as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string"))
      : { status: "unavailable", detail: listed.ok ? "listing is not in the expected shape" : listed.detail };

  const model = o.model ?? provider.models[0]!.id;
  const started = Date.now();
  const answered = await send(
    doFetch,
    new URL("chat/completions", base),
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 16, temperature: 0 }) },
    timeoutMs,
  );
  const latencyMs = Date.now() - started;
  // Success is an answer with a message, not text: a reasoning model may spend a 16-token budget on reasoning.
  const message = answered.body?.choices?.[0]?.message;
  const ok = answered.ok && Boolean(message) && typeof message === "object";
  const detail = ok ? "answered" : answered.ok ? "response has no choices[0].message" : answered.detail;
  const usage = ok ? usageOf(answered.body) : null;
  const price = declaredModelPrice(provider, model);
  const costUsd = usage && price ? (usage.promptTokens * price.inputPerMillionUsd + usage.completionTokens * price.outputPerMillionUsd) / 1_000_000 : null;
  return { ok, error: ok ? null : `chat call failed: ${detail}`, keyFrom, listing, call: { model, ok, latencyMs, detail, usage, costUsd } };
}

function served(provider: ProviderConfig, models: string[]): ConnectionReport["listing"] {
  return { status: "served", models, notListed: provider.models.map((m) => m.id).filter((id) => !models.includes(id)) };
}

function usageOf(body: any): Usage | null {
  const u = body?.usage;
  if (!u) return null;
  return {
    promptTokens: Number(u.prompt_tokens ?? 0),
    completionTokens: Number(u.completion_tokens ?? 0),
    reasoningTokens: typeof u.completion_tokens_details?.reasoning_tokens === "number" ? u.completion_tokens_details.reasoning_tokens : null,
  };
}

interface Answer {
  ok: boolean;
  body: any;
  detail: string;
}

/** One request. Failures are classified, never echoed: the upstream text may reflect our headers. */
async function send(doFetch: typeof fetch, url: URL, init: RequestInit, timeoutMs: number): Promise<Answer> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, body: null, detail: name === "TimeoutError" || name === "AbortError" ? `no response in ${timeoutMs}ms` : `network error (${name ?? "unknown"})` };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, body: null, detail: `redirect refused (HTTP ${res.status}); the key was not sent to the new location` };
  const text = await res.text().catch(() => "");
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: the caller decides whether that matters */
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, body, detail: "ok" };
  return { ok: false, body: null, detail: `${classify(res.status)} (HTTP ${res.status})` };
}

function classify(status: number): string {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 404) return "NOT_FOUND";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  return status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST";
}
