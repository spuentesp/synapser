// Persists every model call in the journal (plan 06 §7): a row, an event on the same channel the
// UI already reads, and the request/response bodies as content-addressed artifacts so a run can be
// audited — or replayed — without calling the model again. Bodies never contain credentials: the
// provider builds them from the payload, which has no auth header.

import type { Journal } from "../journal/journal.ts";
import { estimateCostUsd } from "./pricing.ts";
import type { ModelCallRecord } from "./types.ts";

export function journalRecorder(journal: Journal): (rec: ModelCallRecord) => void {
  return (rec) => {
    const requestBlob = rec.request === null ? null : journal.artifacts.put(Buffer.from(JSON.stringify(rec.request)));
    const responseBlob = rec.response === null ? null : journal.artifacts.put(Buffer.from(JSON.stringify(rec.response)));
    const cost = rec.usage ? estimateCostUsd(rec.servedModel ?? rec.requestedModel, rec.usage) : null;
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
