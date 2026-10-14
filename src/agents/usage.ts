// What each agent CLI tells us about a run. Every number carries its PROVENANCE and absent data is
// `null` — never 0 — so cost analytics cannot silently under-report (observed 13 oct 2026:
// claude reports cost+tokens, codex tokens only, kimi only in its session log, mimo errored with
// exit code 0). The formats below are the ones actually captured by the spike, kept as fixtures.

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provenance = "reported" | "log" | "unknown";
export type Outcome = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface UsageRecord {
  provenance: Provenance;
  /** Fresh (uncached) input tokens. Cached tokens are separate, so totals never double count. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** USD exactly as the tool reported it (a list-price figure, not an invoice). null = not reported. */
  costUsd: number | null;
  models: string[];
  turns: number | null;
  apiMs: number | null;
  note: string | null;
}

export interface ParsedRun {
  /** Decided from the tool's own events — an exit code alone is not trusted (mimo exits 0 on a 402). */
  outcome: Outcome;
  reason: string | null;
  finalText: string | null;
  sessionId: string | null;
  usage: UsageRecord;
  permissionDenials: number | null;
  /** How many times each tool/item kind was used, when the tool reports it (null = not reported). */
  toolUse: Record<string, number> | null;
}

export const unknownUsage = (note: string): UsageRecord => ({
  provenance: "unknown",
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costUsd: null,
  models: [],
  turns: null,
  apiMs: null,
  note,
});

const tally = (names: string[]): Record<string, number> | null => {
  if (names.length === 0) return null;
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (out[n] ?? 0) + 1;
  return out;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const lines = (s: string): Record<string, any>[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const o = JSON.parse(l);
        return typeof o === "object" && o !== null ? [o] : [];
      } catch {
        return [];
      }
    });

// ---- claude -p --output-format json ----------------------------------------------------------

export function parseClaude(stdout: string): ParsedRun {
  let o: Record<string, any>;
  try {
    o = JSON.parse(stdout.trim());
  } catch {
    return { outcome: "UNKNOWN", reason: "stdout is not the expected JSON result", finalText: null, sessionId: null, usage: unknownUsage("unparseable output"), permissionDenials: null, toolUse: null };
  }
  const u = (o["usage"] ?? {}) as Record<string, any>;
  const failed = o["is_error"] === true || (typeof o["subtype"] === "string" && o["subtype"] !== "success");
  return {
    outcome: failed ? "FAILED" : o["type"] === "result" ? "SUCCEEDED" : "UNKNOWN",
    reason: failed ? String(o["subtype"] ?? o["api_error_status"] ?? "error") : null,
    finalText: typeof o["result"] === "string" ? o["result"] : null,
    sessionId: typeof o["session_id"] === "string" ? o["session_id"] : null,
    permissionDenials: Array.isArray(o["permission_denials"]) ? o["permission_denials"].length : null,
    toolUse: null, // claude's JSON result does not list individual tool calls
    usage: {
      provenance: "reported",
      inputTokens: num(u["input_tokens"]),
      outputTokens: num(u["output_tokens"]),
      cacheReadTokens: num(u["cache_read_input_tokens"]),
      cacheWriteTokens: num(u["cache_creation_input_tokens"]),
      reasoningTokens: num(u["output_tokens_details"]?.["thinking_tokens"]),
      costUsd: num(o["total_cost_usd"]),
      models: Object.keys((o["modelUsage"] ?? {}) as object),
      turns: num(o["num_turns"]),
      apiMs: num(o["duration_api_ms"]),
      note: "cost is claude's list-price figure",
    },
  };
}

// ---- codex exec --json -----------------------------------------------------------------------

export function parseCodex(stdout: string): ParsedRun {
  const ev = lines(stdout);
  const done = ev.filter((e) => e["type"] === "turn.completed").at(-1);
  const failure = ev.find((e) => e["type"] === "turn.failed" || e["type"] === "error");
  const msgs = ev.filter((e) => e["type"] === "item.completed" && e["item"]?.type === "agent_message");
  const thread = ev.find((e) => e["type"] === "thread.started")?.["thread_id"];
  const u = (done?.["usage"] ?? null) as Record<string, any> | null;
  const cached = num(u?.["cached_input_tokens"]);
  const inTotal = num(u?.["input_tokens"]);
  return {
    outcome: failure ? "FAILED" : done ? "SUCCEEDED" : "UNKNOWN",
    reason: failure ? String(failure["message"] ?? failure["error"]?.message ?? failure["type"]) : done ? null : "no turn.completed event",
    finalText: msgs.length ? String(msgs.at(-1)!["item"].text ?? "") : null,
    sessionId: typeof thread === "string" ? thread : null,
    permissionDenials: null,
    toolUse: tally(ev.filter((e) => e["type"] === "item.completed" && e["item"]?.type && e["item"].type !== "agent_message").map((e) => String(e["item"].type))),
    usage: u
      ? {
          provenance: "reported",
          // OpenAI-style accounting: cached_input_tokens is a SUBSET of input_tokens.
          inputTokens: inTotal !== null && cached !== null ? inTotal - cached : inTotal,
          outputTokens: num(u["output_tokens"]),
          cacheReadTokens: cached,
          cacheWriteTokens: num(u["cache_write_input_tokens"]),
          reasoningTokens: num(u["reasoning_output_tokens"]),
          costUsd: null,
          models: [],
          turns: ev.filter((e) => e["type"] === "turn.completed").length,
          apiMs: null,
          note: "codex reports tokens but no USD; input is net of cached (assumed subset)",
        }
      : unknownUsage("no turn.completed usage event"),
  };
}

// ---- kimi -p --output-format stream-json (+ its session log) ---------------------------------

export interface KimiOptions {
  /** Root that contains `<workdir>/<session_id>/agents/main/wire.jsonl`. Default ~/.kimi-code/sessions. */
  sessionsRoot?: string;
  /** Test hook: wire log content, bypassing the filesystem lookup. */
  wireText?: string;
}

export function parseKimi(stdout: string, opts: KimiOptions = {}): ParsedRun {
  const ev = lines(stdout);
  const resume = ev.find((e) => e["type"] === "session.resume_hint");
  const sessionId = typeof resume?.["session_id"] === "string" ? (resume["session_id"] as string) : null;
  const text = ev.filter((e) => e["role"] === "assistant" && typeof e["content"] === "string").at(-1)?.["content"] ?? null;
  const toolUse = tally(ev.filter((e) => e["role"] === "assistant" && Array.isArray(e["tool_calls"])).flatMap((e) => (e["tool_calls"] as any[]).map((c) => String(c?.function?.name ?? "?"))));

  let wire = opts.wireText ?? null;
  if (wire === null && sessionId) {
    const root = opts.sessionsRoot ?? join(homedir(), ".kimi-code", "sessions");
    try {
      for (const d of readdirSync(root)) {
        try {
          wire = readFileSync(join(root, d, sessionId, "agents", "main", "wire.jsonl"), "utf8");
          break;
        } catch {
          /* not in this workdir */
        }
      }
    } catch {
      /* no sessions dir */
    }
  }
  if (wire === null) {
    return { outcome: "UNKNOWN", reason: "kimi prints no usage or status; session log not found", finalText: text, sessionId, permissionDenials: null, toolUse, usage: unknownUsage("session log not found") };
  }
  const w = lines(wire);
  const steps = w.map((e) => e["event"]).filter((e) => e && e.type === "step.end");
  const turnEnd = w.filter((e) => e["type"] === "agent.turn.ended").at(-1);
  const sum = (k: string) => steps.reduce((a, s) => a + (num(s.usage?.[k]) ?? 0), 0);
  const models = [...new Set(w.filter((e) => e["type"] === "llm.request").map((e) => String(e["modelAlias"] ?? e["model"])))];
  const ok = turnEnd?.["outcome"] === "done";
  return {
    outcome: turnEnd ? (ok ? "SUCCEEDED" : "FAILED") : "UNKNOWN",
    reason: turnEnd ? (ok ? null : String(turnEnd["outcome"])) : "no agent.turn.ended in session log",
    finalText: text,
    sessionId,
    permissionDenials: null,
    toolUse,
    usage: steps.length
      ? {
          provenance: "log",
          inputTokens: sum("inputOther"),
          outputTokens: sum("output"),
          cacheReadTokens: sum("inputCacheRead"),
          cacheWriteTokens: sum("inputCacheCreation"),
          reasoningTokens: null,
          costUsd: null,
          models,
          turns: steps.length,
          apiMs: steps.reduce((a, s) => a + (num(s.llmStreamDurationMs) ?? 0) + (num(s.llmFirstTokenLatencyMs) ?? 0), 0),
          note: "from kimi's session log (step.end); no USD available",
        }
      : unknownUsage("no step.end events in session log"),
  };
}

// ---- mimo run --format json ------------------------------------------------------------------

export function parseMimo(stdout: string): ParsedRun {
  const ev = lines(stdout);
  const err = ev.find((e) => e["type"] === "error");
  const sessionId = ev.find((e) => typeof e["sessionID"] === "string")?.["sessionID"] ?? null;
  if (err) {
    const d = err["error"]?.data ?? {};
    return {
      outcome: "FAILED",
      reason: `${String(err["error"]?.name ?? "error")}: ${String(d.message ?? "")} (HTTP ${String(d.statusCode ?? "?")})`.trim(),
      finalText: null,
      sessionId: typeof sessionId === "string" ? sessionId : null,
      permissionDenials: null,
      toolUse: null,
      usage: unknownUsage("run failed before any model usage"),
    };
  }
  return {
    outcome: "UNKNOWN",
    reason: "success event format has not been observed (account had no balance during the spike)",
    finalText: null,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    permissionDenials: null,
    toolUse: null,
    usage: unknownUsage("usage is only in `mimo export`; not collected"),
  };
}

/**
 * For a generic CLI that prints no events. The ONLY evidence is its exit code (the runner downgrades a
 * non-zero exit to FAILED) and, later, whether its change set integrates and passes acceptance. Usage is
 * UNKNOWN and says so: nothing is invented.
 */
export function parsePlain(out: string): ParsedRun {
  const tail = out.trim().split("\n").slice(-12).join("\n").slice(-1500);
  return { outcome: "SUCCEEDED", reason: null, finalText: tail || null, sessionId: null, permissionDenials: null, toolUse: null, usage: unknownUsage("a plain CLI reports no usage") };
}

export const PARSERS = {
  plain: (out: string) => parsePlain(out),
  "claude-json": (out: string) => parseClaude(out),
  "codex-jsonl": (out: string) => parseCodex(out),
  "kimi-stream": (out: string, o?: KimiOptions) => parseKimi(out, o),
  "mimo-json": (out: string) => parseMimo(out),
} as const;
export type ParserId = keyof typeof PARSERS;
