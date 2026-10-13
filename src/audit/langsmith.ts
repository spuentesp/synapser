// Optional exporter: ledger → LangSmith traces, shaped by LangSmith's "coding agent metadata contract"
// (coding-agent-v1). It is a VIEW of the ledger, not a source of truth: the hash-chained journal stays
// authoritative and every exported root carries the chain head so a LangSmith trace can be checked
// against it. By default NO content leaves the machine (prompts, final text, file bytes): only ids,
// states, digests, paths and numbers. Run ids are deterministic, so re-exporting is idempotent.

import { createHash } from "node:crypto";
import type { Journal } from "../journal/journal.ts";
import { verifyChain } from "./chain.ts";

export interface LsRun {
  id: string;
  trace_id: string;
  parent_run_id?: string;
  dotted_order: string;
  name: string;
  run_type: "chain" | "llm" | "tool";
  start_time: string;
  end_time: string;
  session_name: string;
  error?: string;
  extra: { metadata: Record<string, unknown> };
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  tags: string[];
}

export interface MapOptions {
  project: string;
  /** false (default): no prompt text, no final text, no file contents. */
  includeContent?: boolean;
  runtimeName?: string;
}

const SCHEMA = "coding-agent-v1";

/** Deterministic UUIDv7: 48-bit ms timestamp (so LangSmith orders runs correctly) + hash bits. */
export function detUuid7(ms: number, seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(Math.max(0, Math.floor(ms)), 0, 6);
  h.copy(b, 6, 0, 10);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const stamp = (ms: number) => {
  const d = new Date(ms).toISOString(); // 2026-10-13T20:56:39.217Z
  return `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}T${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}${d.slice(20, 23)}000Z`;
};
const iso = (ms: number) => new Date(ms).toISOString();

const blobText = (j: Journal, ref: string): string => {
  try {
    return j.artifacts.get(ref).toString("utf8");
  } catch {
    return "(unavailable)";
  }
};

const providerOf = (model: string): string => {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("codex") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.includes("nemotron") || m.startsWith("nvidia/")) return "nvidia";
  if (m.includes("mimo") || m.includes("xiaomi")) return "xiaomi";
  if (m.includes("kimi") || m.includes("moonshot")) return "moonshot";
  return "unknown";
};

type Ev = ReturnType<Journal["listEvents"]>[number];

export function ledgerToRuns(journal: Journal, o: MapOptions): LsRun[] {
  const events = journal.listEvents();
  if (events.length === 0) return [];
  const runId = journal.runId;
  const content = o.includeContent === true;
  const runtime = o.runtimeName ?? "synapser 0.0.1";
  const head = verifyChain(runId, journal.eventChain()).head;
  const mission = journal.getMission();
  const runs: LsRun[] = [];
  const dotted = new Map<string, string>();

  const identity = (agentType: string, extra: Record<string, unknown> = {}) => ({
    ls_agent_type: agentType,
    ls_agent_purpose: "coding",
    ls_integration: "synapser",
    ls_agent_runtime: runtime,
    ls_trace_schema_version: SCHEMA,
    thread_id: runId,
    ...extra,
  });

  const add = (r: {
    key: string;
    parentKey: string | null;
    name: string;
    type: LsRun["run_type"];
    start: number;
    end: number;
    metadata: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    error?: string;
    tags?: string[];
  }) => {
    const id = detUuid7(r.start, `${runId}|${r.key}`);
    const parentId = r.parentKey ? detUuid7(startOf.get(r.parentKey) as number, `${runId}|${r.parentKey}`) : null;
    const own = `${stamp(r.start)}${id}`;
    const order = parentId ? `${dotted.get(r.parentKey as string)}.${own}` : own;
    dotted.set(r.key, order);
    startOf.set(r.key, r.start);
    const traceId = order.split(".")[0]!.split("Z")[1] as string;
    runs.push({
      id,
      trace_id: traceId,
      ...(parentId ? { parent_run_id: parentId } : {}),
      dotted_order: order,
      name: r.name,
      run_type: r.type,
      start_time: iso(r.start),
      end_time: iso(Math.max(r.start, r.end)),
      session_name: o.project,
      ...(r.error ? { error: r.error } : {}),
      extra: { metadata: r.metadata },
      inputs: r.inputs ?? {},
      outputs: r.outputs ?? {},
      tags: r.tags ?? ["synapser"],
    });
  };
  const startOf = new Map<string, number>();

  // ---- root: the mission -------------------------------------------------------------------
  const t0 = events[0]!.ts;
  const tN = events.at(-1)!.ts;
  add({
    key: "mission",
    parentKey: null,
    name: `mission: ${mission?.objective?.slice(0, 80) ?? runId}`,
    type: "chain",
    start: t0,
    end: tN,
    metadata: identity("root", { synapser_run_id: runId, synapser_ledger_head: head, synapser_ledger_events: events.length, synapser_mission_state: mission?.state ?? null }),
    inputs: content ? { objective: mission?.objective ?? null } : { objective_sha256: createHash("sha256").update(mission?.objective ?? "").digest("hex") },
    outputs: { state: mission?.state ?? null },
    ...(mission?.state === "FAILED" ? { error: "mission failed" } : {}),
  });

  // ---- agent runs (+ model calls / tools beneath them) ------------------------------------
  const calls = journal.listModelCalls();
  const raw = journal.listEvents();
  for (const r of journal.listAgentRuns()) {
    const key = `agent_run|${r.agentRunId}`;
    add({
      key,
      parentKey: "mission",
      name: `${r.profileId}`,
      type: "chain",
      start: r.startedAt,
      end: r.finishedAt,
      metadata: identity("subagent", {
        ls_subagent_id: r.agentRunId,
        ls_subagent_type: r.role,
        synapser_adapter: r.adapter,
        synapser_task_id: r.taskId,
        synapser_outcome: r.outcome,
        synapser_usage_provenance: r.usageProvenance,
        synapser_cost_usd: r.costUsd,
        synapser_session_id: r.sessionId,
        synapser_exit_code: r.exitCode,
      }),
      // the blob id is a content hash: it names the prompt without disclosing it
      inputs: { prompt_blob: r.promptBlob, ...(content && r.promptBlob ? { prompt: blobText(journal, r.promptBlob) } : {}) },
      outputs: {
        outcome: r.outcome,
        changed_paths: r.changes.map((c) => c.path),
        ...(content && r.finalTextBlob ? { final_text: blobText(journal, r.finalTextBlob) } : {}),
      },
      ...(r.outcome === "FAILED" ? { error: r.reason ?? "failed" } : {}),
    });

    const nativeCalls =
      r.adapter === "native" ? calls.filter((c) => c.taskId === r.taskId && c.role !== "supervisor" && c.startedAt >= r.startedAt && c.startedAt <= r.finishedAt) : [];
    const llmFromCalls = nativeCalls.length > 0;
    if (llmFromCalls) {
      // exact per-call usage recorded by the provider
      for (const c of nativeCalls) {
        const model = c.servedModel ?? c.requestedModel;
        add({
          key: `model_call|${c.callId}`,
          parentKey: key,
          name: model,
          type: "llm",
          start: c.startedAt,
          end: c.startedAt + (c.latencyMs ?? 0),
          metadata: {
            ...identity("subagent"),
            ls_provider: providerOf(model),
            ls_model_name: model,
            ...(c.promptTokens !== null && c.completionTokens !== null
              ? { usage_metadata: { input_tokens: c.promptTokens, output_tokens: c.completionTokens, total_tokens: c.promptTokens + c.completionTokens, ...(c.costUsd !== null ? { total_cost: c.costUsd } : {}) } }
              : {}),
            synapser_fallback_used: c.fallbackUsed,
            synapser_retries: c.retries,
          },
          ...(c.error ? { error: c.error } : {}),
        });
      }
    } else if (r.inputTokens !== null || r.outputTokens !== null) {
      const model = r.models[0] ?? r.profileId;
      const inTot = (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      add({
        key: `${key}|llm`,
        parentKey: key,
        name: model,
        type: "llm",
        start: r.startedAt,
        end: r.finishedAt,
        metadata: {
          ...identity("subagent"),
          ls_provider: providerOf(model),
          ls_model_name: model,
          usage_metadata: {
            input_tokens: inTot,
            output_tokens: r.outputTokens ?? 0,
            total_tokens: inTot + (r.outputTokens ?? 0),
            input_token_details: { ...(r.cacheReadTokens !== null ? { cache_read: r.cacheReadTokens } : {}), ...(r.cacheWriteTokens !== null ? { cache_creation: r.cacheWriteTokens } : {}) },
            ...(r.reasoningTokens !== null ? { output_token_details: { reasoning: r.reasoningTokens } } : {}),
            ...(r.costUsd !== null ? { total_cost: r.costUsd } : {}),
          },
          synapser_usage_provenance: r.usageProvenance,
        },
      });
    }
    // tools: native steps are individual events; CLI runs report counts
    if (r.toolUse) {
      for (const [tool, count] of Object.entries(r.toolUse)) {
        add({ key: `${key}|tool|${tool}`, parentKey: key, name: tool, type: "tool", start: r.startedAt, end: r.finishedAt, metadata: { ...identity("subagent"), ls_tool_name: tool, synapser_count: count } });
      }
    }
  }

  // ---- actions: what actually changed files --------------------------------------------------
  const integ = new Map<string, string>(); // action id → agent run id
  for (const e of raw) {
    const d = (e.data ?? {}) as { action_id?: string | null };
    if (e.entity === "agent_run_integration" && d.action_id) integ.set(d.action_id, e.entityId);
  }
  const byAction = new Map<string, Ev[]>();
  for (const e of raw) if (e.entity === "action") (byAction.get(e.entityId) ?? byAction.set(e.entityId, []).get(e.entityId)!).push(e);
  for (const [actionId, evs] of byAction) {
    const a = journal.getAction(actionId);
    if (!a) continue;
    const linkedRun = integ.get(actionId);
    const parentKey = linkedRun && startOf.has(`agent_run|${linkedRun}`) ? `agent_run|${linkedRun}` : "mission";
    const files = journal.getActionFiles(actionId);
    add({
      key: `action|${actionId}`,
      parentKey,
      name: `apply ${a.state === "SETTLED" ? "" : `(${a.state}) `}${files.map((f) => f.path).join(", ")}`.trim(),
      type: "tool",
      start: evs[0]!.ts,
      end: evs.at(-1)!.ts,
      metadata: { ...identity("subagent"), ls_tool_name: "apply_changes", synapser_action_id: actionId, synapser_task_id: a.taskId, synapser_state: a.state, synapser_error_code: a.errorCode },
      inputs: { files: files.map((f) => ({ path: f.path, op: f.op, before: f.beforeDigest })) },
      outputs: { state: a.state, files: files.map((f) => ({ path: f.path, after: f.afterDigest, progress: f.progress })) },
      ...(a.errorCode ? { error: a.errorCode } : {}),
    });
  }

  // ---- validations ---------------------------------------------------------------------------
  for (const v of journal.listValidations()) {
    const end = v.finishedAt ?? v.startedAt;
    add({
      key: `validation|${v.validationId}`,
      parentKey: "mission",
      name: `validation: ${v.command}`,
      type: "tool",
      start: v.startedAt,
      end,
      metadata: { ...identity("subagent"), ls_tool_name: "validation", synapser_snapshot_digest: v.snapshotDigest, synapser_valid: v.valid },
      outputs: { exit_code: v.exitCode, valid: v.valid, passed: v.valid && v.exitCode === 0 },
      ...(v.exitCode !== 0 || !v.valid ? { error: `exit ${String(v.exitCode)}${v.valid ? "" : " (snapshot not valid)"}` } : {}),
    });
  }
  return runs;
}

// ---- transport ------------------------------------------------------------------------------

export interface SendOptions {
  apiKey: string;
  endpoint?: string;
  workspaceId?: string;
  fetch?: typeof fetch;
  batchSize?: number;
}

export interface SendResult {
  runs: number;
  requests: number;
}

export class LangSmithError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`LangSmith HTTP ${status}: ${message}`);
    this.name = "LangSmithError";
    this.status = status;
  }
}

/**
 * POST /runs/multipart: one JSON part per run (`post.<id>`) plus separate inputs/outputs parts.
 * The endpoint REQUIRES a Content-Length header on every part (it answers 422 otherwise), which the
 * platform FormData does not add — so the body is assembled by hand.
 */
export function buildMultipart(runs: readonly LsRun[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  const part = (name: string, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`, "utf8"),
      body,
      Buffer.from("\r\n", "utf8"),
    );
  };
  for (const run of runs) {
    const { inputs, outputs, ...head } = run;
    part(`post.${run.id}`, head);
    if (Object.keys(inputs).length) part(`post.${run.id}.inputs`, inputs);
    if (Object.keys(outputs).length) part(`post.${run.id}.outputs`, outputs);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

export async function sendRuns(runs: readonly LsRun[], o: SendOptions): Promise<SendResult> {
  const f = o.fetch ?? fetch;
  const endpoint = (o.endpoint ?? "https://api.smith.langchain.com").replace(/\/$/, "");
  const size = o.batchSize ?? 50;
  let requests = 0;
  for (let i = 0; i < runs.length; i += size) {
    const boundary = `synapser-${createHash("sha256").update(String(i) + String(runs.length)).digest("hex").slice(0, 24)}`;
    const body = buildMultipart(runs.slice(i, i + size), boundary);
    const res = await f(`${endpoint}/runs/multipart`, {
      method: "POST",
      headers: {
        "x-api-key": o.apiKey,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        ...(o.workspaceId ? { "x-tenant-id": o.workspaceId } : {}),
      },
      body,
    });
    requests++;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300).replaceAll(o.apiKey, "***");
      throw new LangSmithError(res.status, text);
    }
  }
  return { runs: runs.length, requests };
}

export async function exportToLangSmith(journal: Journal, map: MapOptions, send: SendOptions): Promise<SendResult & { head: string }> {
  const runs = ledgerToRuns(journal, map);
  const r = await sendRuns(runs, send);
  return { ...r, head: verifyChain(journal.runId, journal.eventChain()).head };
}
