// Persists every model call in the journal (plan 06 §7): a row, an event on the same channel the
// UI already reads, and the request/response bodies as content-addressed artifacts so a run can be
// audited — or replayed — without calling the model again. Bodies never contain credentials: the
// provider builds them from the payload, which has no auth header.

import type { Journal } from "../journal/journal.ts";
import type { ProviderConfig } from "./config.ts";
import { estimateCostUsd, type ModelPrice } from "./pricing.ts";
import type { ModelCallRecord } from "./types.ts";

export type PriceResolver = (baseUrl: string, model: string) => ModelPrice | null;

/** Resolve declared prices by provider URL as well as model id (model ids are not globally unique). */
export function priceResolverForProviders(providers: Readonly<Record<string, ProviderConfig>>): PriceResolver {
  const normalized = (url: string) => url.replace(/\/+$/, "");
  return (baseUrl, model) => {
    const matches = Object.values(providers)
      .filter((item) => normalized(item.baseUrl) === normalized(baseUrl))
      .map((provider) => provider.models.find((item) => item.id === model))
      .filter((item) => item !== undefined);
    // ModelCallRecord predates provider ids. Refuse an ambiguous URL/model pair instead of
    // attributing another provider's tariff; a future schema can carry provider identity directly.
    const declared = matches.length === 1 ? matches[0] : undefined;
    return declared?.usdPer1MIn !== undefined && declared.usdPer1MOut !== undefined
      ? { inputPerMillionUsd: declared.usdPer1MIn, outputPerMillionUsd: declared.usdPer1MOut }
      : null;
  };
}

export function journalRecorder(journal: Journal, resolvePrice?: PriceResolver): (rec: ModelCallRecord) => void {
  return (rec) => {
    const requestBlob = rec.request === null ? null : journal.artifacts.put(Buffer.from(JSON.stringify(rec.request)));
    const responseBlob = rec.response === null ? null : journal.artifacts.put(Buffer.from(JSON.stringify(rec.response)));
    const model = rec.servedModel ?? rec.attemptedModel ?? rec.requestedModel;
    // Some OpenAI-compatible gateways report a deployment or dated alias instead of a catalog id.
    // Price a declared served model first, then the model actually sent. Only a primary request may
    // fall back to its requested declaration; a fallback alias must never inherit the primary tariff.
    const declared = resolvePrice
      ? resolvePrice(rec.baseUrl, model) ??
        (rec.attemptedModel !== rec.requestedModel ? resolvePrice(rec.baseUrl, rec.attemptedModel) : null) ??
        (rec.fallbackUsed ? null : resolvePrice(rec.baseUrl, rec.requestedModel))
      : null;
    const cost = rec.usage
      ? resolvePrice
        ? declared
          ? (rec.usage.promptTokens * declared.inputPerMillionUsd + rec.usage.completionTokens * declared.outputPerMillionUsd) / 1_000_000
          : null
        : estimateCostUsd(model, rec.usage)
      : null;
    journal.tx((t) =>
      t.insertModelCall({
        callId: rec.callId,
        runId: rec.runId,
        taskId: rec.taskId,
        role: rec.role,
        requestedModel: rec.requestedModel,
        servedModel: rec.servedModel,
        baseUrl: rec.baseUrl,
        startedAt: rec.startedAt,
        latencyMs: rec.latencyMs,
        httpStatus: rec.httpStatus,
        retries: rec.retries,
        promptTokens: rec.usage?.promptTokens ?? null,
        completionTokens: rec.usage?.completionTokens ?? null,
        reasoningTokens: rec.usage?.reasoningTokens ?? null,
        finishReason: rec.finishReason,
        fallbackUsed: rec.fallbackUsed,
        costUsd: cost,
        error: rec.error,
        requestBlob,
        responseBlob,
      }),
    );
  };
}
