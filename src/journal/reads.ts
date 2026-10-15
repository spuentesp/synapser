// Plan 18 E12 (H12.5, finding 3): the read side of the journal. Each function takes the connection and the run it reads,
// so they hold no state and the write side (Journal and Tx) stays in journal.ts. Journal's read methods keep their names
// and signatures and forward here.
import type { DatabaseSync } from "node:sqlite";
import type { Digest } from "../digest/file.ts";
import type { ActionState } from "./transitions.ts";
import type { ActionFileRow, ActionRow, ResearchCallRow, SessionRow, EventRow, ChildRow, AgentRunInsert } from "./journal.ts";

type Row = Record<string, unknown>;

const toAction = (r: Row): ActionRow => ({
  runId: r["run_id"] as string,
  actionId: r["action_id"] as string,
  taskId: r["task_id"] as string,
  actorOwner: r["actor_owner"] as string,
  incarnation: r["incarnation"] as number,
  planRevision: r["plan_revision"] as number,
  requestDigest: r["request_digest"] as Digest,
  state: r["state"] as ActionState,
  attempt: r["attempt"] as number,
  errorCode: (r["error_code"] as string | null) ?? null,
  receipt: r["receipt_json"] ? JSON.parse(r["receipt_json"] as string) : null,
  registryCleanup: (r["registry_cleanup"] as "CLEARED" | "UNVERIFIED" | null) ?? null,
  fsCleanup: "NOT_ATTESTED",
  preparedAt: r["prepared_at"] as number,
  updatedAt: r["updated_at"] as number,
});
const toFile = (r: Row): ActionFileRow => ({
  runId: r["run_id"] as string,
  actionId: r["action_id"] as string,
  path: r["path"] as string,
  op: r["op"] as "create" | "replace" | "delete",
  beforeDigest: (r["before_digest"] as Digest | null) ?? null,
  afterDigest: (r["after_digest"] as Digest | null) ?? null,
  beforeMode: (r["before_mode"] as number | null) ?? null,
  afterMode: (r["after_mode"] as number | null) ?? null,
  beforeBlob: (r["before_blob"] as Digest | null) ?? null,
  afterBlob: (r["after_blob"] as Digest | null) ?? null,
  tmpName: (r["tmp_name"] as string | null) ?? null,
  progress: r["progress"] as "PENDING" | "APPLIED",
  observedDigest: (r["observed_digest"] as string | null) ?? null,
});

export function getAction(db: DatabaseSync, runId: string, actionId: string): ActionRow | null {
  const r = db.prepare("SELECT * FROM actions WHERE run_id=? AND action_id=?").get(runId, actionId) as Row | undefined;
  return r ? toAction(r) : null;
}

export function getActionFiles(db: DatabaseSync, runId: string, actionId: string): ActionFileRow[] {
  return (db.prepare("SELECT * FROM action_files WHERE run_id=? AND action_id=? ORDER BY path").all(runId, actionId) as Row[]).map(toFile);
}

export function listNonTerminal(db: DatabaseSync, runId: string): ActionRow[] {
  return (
    db
      .prepare("SELECT * FROM actions WHERE run_id=? AND state NOT IN ('SETTLED','REJECTED') ORDER BY prepared_at, action_id")
      .all(runId) as Row[]
  ).map(toAction);
}

export function getSessionIncarnation(db: DatabaseSync, runId: string, actorOwner: string): number | null {
  const r = db.prepare("SELECT incarnation FROM sessions WHERE run_id=? AND actor_owner=?").get(runId, actorOwner) as Row | undefined;
  return r ? (r["incarnation"] as number) : null;
}

export function getView(db: DatabaseSync, runId: string, viewId: string): { taskId: string; files: { path: string; digest: string; mode: number | null; blobRef: string | null }[] } | null {
  const rows = db.prepare("SELECT * FROM views WHERE run_id=? AND view_id=? ORDER BY path").all(runId, viewId) as Row[];
  if (rows.length === 0) return null;
  return {
    taskId: rows[0]!["task_id"] as string,
    files: rows.map((r) => ({
      path: r["path"] as string,
      digest: r["digest"] as string,
      mode: (r["mode"] as number | null) ?? null,
      blobRef: (r["blob_ref"] as string | null) ?? null,
    })),
  };
}

export function listResearchCalls(db: DatabaseSync, runId: string): ResearchCallRow[] {
  return (db.prepare("SELECT * FROM research_calls WHERE run_id=? ORDER BY started_at, call_id").all(runId) as Row[]).map((r) => ({
    callId: r["call_id"] as string,
    taskId: (r["task_id"] as string | null) ?? null,
    role: r["role"] as string,
    provider: r["provider"] as string,
    query: (r["query"] as string | null) ?? null,
    querySha256: r["query_sha256"] as string,
    startedAt: r["started_at"] as number,
    latencyMs: (r["latency_ms"] as number | null) ?? null,
    creditsUsed: (r["credits_used"] as number | null) ?? null,
    cached: (r["cached"] as number) === 1,
    resultBlob: (r["result_blob"] as string | null) ?? null,
    error: (r["error"] as string | null) ?? null,
    urls: JSON.parse(r["urls_json"] as string) as string[],
  }));
}

export function listModelCalls(db: DatabaseSync, runId: string): { callId: string; taskId: string | null; startedAt: number; latencyMs: number | null; role: string; requestedModel: string; servedModel: string | null; promptTokens: number | null;
  completionTokens: number | null; costUsd: number | null; error: string | null; requestBlob: string | null; responseBlob: string | null; fallbackUsed: boolean; retries: number }[] {
  return (db.prepare("SELECT * FROM model_calls WHERE run_id=? ORDER BY started_at, call_id").all(runId) as Row[]).map((r) => ({
    callId: r["call_id"] as string,
    taskId: (r["task_id"] as string | null) ?? null,
    startedAt: r["started_at"] as number,
    latencyMs: (r["latency_ms"] as number | null) ?? null,
    role: r["role"] as string,
    requestedModel: r["requested_model"] as string,
    servedModel: (r["served_model"] as string | null) ?? null,
    promptTokens: (r["prompt_tokens"] as number | null) ?? null,
    completionTokens: (r["completion_tokens"] as number | null) ?? null,
    costUsd: (r["cost_usd"] as number | null) ?? null,
    error: (r["error"] as string | null) ?? null,
    requestBlob: (r["request_blob"] as string | null) ?? null,
    responseBlob: (r["response_blob"] as string | null) ?? null,
    fallbackUsed: r["fallback_used"] === 1,
    retries: r["retries"] as number,
  }));
}

export function eventChain(db: DatabaseSync, runId: string): import("../audit/chain.ts").ChainEvent[] {
  return (db.prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq").all(runId) as Row[]).map((r) => ({
    runId: r["run_id"] as string,
    seq: r["seq"] as number,
    ts: r["ts"] as number,
    entity: r["entity"] as string,
    entityId: r["entity_id"] as string,
    fromState: (r["from_state"] as string | null) ?? null,
    toState: (r["to_state"] as string | null) ?? null,
    dataJson: r["data_json"] as string,
    prevHash: r["prev_hash"] as string,
    hash: r["hash"] as string,
  }));
}

export function getMission(db: DatabaseSync, runId: string): { objective: string; state: string; planRevision: number } | null {
  const r = db.prepare("SELECT objective, state, plan_revision FROM missions WHERE run_id=?").get(runId) as Row | undefined;
  return r ? { objective: r["objective"] as string, state: r["state"] as string, planRevision: r["plan_revision"] as number } : null;
}

export function listAllActions(db: DatabaseSync, runId: string): ActionRow[] {
  return (db.prepare("SELECT * FROM actions WHERE run_id=? ORDER BY prepared_at, action_id").all(runId) as Row[]).map(toAction);
}

export function getMissionState(db: DatabaseSync, runId: string): string | null {
  const r = db.prepare("SELECT state FROM missions WHERE run_id=?").get(runId) as Row | undefined;
  return r ? (r["state"] as string) : null;
}

export function listPlanRevisions(db: DatabaseSync, runId: string): { revision: number; plan: any; acceptedAt: number | null }[] {
  return (db.prepare("SELECT * FROM plan_revisions WHERE run_id=? ORDER BY revision").all(runId) as Row[]).map((r) => ({
    revision: r["revision"] as number,
    plan: JSON.parse(r["plan_json"] as string),
    acceptedAt: (r["accepted_at"] as number | null) ?? null,
  }));
}

export function listTasks(db: DatabaseSync, runId: string): { taskId: string; actorOwner: string; state: string; priority: number; scope: string[]; spec: any; deps: string[] }[] {
  const deps = db.prepare("SELECT task_id, depends_on FROM task_deps WHERE run_id=?").all(runId) as Row[];
  return (db.prepare("SELECT * FROM tasks WHERE run_id=? ORDER BY priority DESC, task_id").all(runId) as Row[]).map((r) => ({
    taskId: r["task_id"] as string,
    actorOwner: r["actor_owner"] as string,
    state: r["state"] as string,
    priority: r["priority"] as number,
    scope: JSON.parse(r["scope_json"] as string),
    spec: JSON.parse(r["criteria_json"] as string),
    deps: deps.filter((d) => d["task_id"] === r["task_id"]).map((d) => d["depends_on"] as string).sort(),
  }));
}

export function listValidations(db: DatabaseSync, runId: string): { validationId: string; taskId: string; command: string; snapshotDigest: string; exitCode: number | null; valid: boolean; outputBlob: string | null; startedAt: number; finishedAt: number | null }[] {
  return (db.prepare("SELECT * FROM validations WHERE run_id=? ORDER BY started_at, validation_id").all(runId) as Row[]).map((r) => ({
    validationId: r["validation_id"] as string,
    taskId: r["task_id"] as string,
    command: r["command"] as string,
    snapshotDigest: r["snapshot_digest"] as string,
    exitCode: (r["exit_code"] as number | null) ?? null,
    valid: r["valid"] === 1,
    outputBlob: (r["output_blob"] as string | null) ?? null,
    startedAt: r["started_at"] as number,
    finishedAt: (r["finished_at"] as number | null) ?? null,
  }));
}

export function listAgentRuns(db: DatabaseSync, runId: string): (AgentRunInsert & { outcome: string })[] {
  return (db.prepare("SELECT * FROM agent_runs WHERE run_id=? ORDER BY started_at, agent_run_id").all(runId) as Row[]).map((r) => ({
    agentRunId: r["agent_run_id"] as string,
    runId: r["run_id"] as string,
    taskId: (r["task_id"] as string | null) ?? null,
    profileId: r["profile_id"] as string,
    role: r["role"] as string,
    adapter: r["adapter"] as string,
    startedAt: r["started_at"] as number,
    finishedAt: r["finished_at"] as number,
    durationMs: r["duration_ms"] as number,
    argv: JSON.parse(r["argv_json"] as string),
    baseDigest: r["base_digest"] as string,
    exitCode: (r["exit_code"] as number | null) ?? null,
    signal: (r["signal"] as string | null) ?? null,
    timedOut: r["timed_out"] === 1,
    outcome: r["outcome"] as "SUCCEEDED" | "FAILED" | "UNKNOWN",
    reason: (r["reason"] as string | null) ?? null,
    sessionId: (r["session_id"] as string | null) ?? null,
    models: JSON.parse((r["models_json"] as string | null) ?? "[]"),
    usageProvenance: (r["usage_provenance"] as string | null) ?? "unknown",
    inputTokens: (r["input_tokens"] as number | null) ?? null,
    outputTokens: (r["output_tokens"] as number | null) ?? null,
    cacheReadTokens: (r["cache_read_tokens"] as number | null) ?? null,
    cacheWriteTokens: (r["cache_write_tokens"] as number | null) ?? null,
    reasoningTokens: (r["reasoning_tokens"] as number | null) ?? null,
    costUsd: (r["cost_usd"] as number | null) ?? null,
    turns: (r["turns"] as number | null) ?? null,
    apiMs: (r["api_ms"] as number | null) ?? null,
    networkIsolated: r["network_isolated"] === 1,
    permissionDenials: (r["permission_denials"] as number | null) ?? null,
    promptBlob: (r["prompt_blob"] as string | null) ?? null,
    stdoutBlob: (r["stdout_blob"] as string | null) ?? null,
    stderrBlob: (r["stderr_blob"] as string | null) ?? null,
    finalTextBlob: (r["final_text_blob"] as string | null) ?? null,
    toolUse: r["tool_use_json"] ? JSON.parse(r["tool_use_json"] as string) : null,
    changes: JSON.parse(r["changes_json"] as string),
    skills: JSON.parse((r["skills_json"] as string | null) ?? "[]"),
    injection: r["injection_json"] ? JSON.parse(r["injection_json"] as string) : null,
  }));
}

export function listChildren(db: DatabaseSync, runId: string): ChildRow[] {
  return (db.prepare("SELECT * FROM children ORDER BY pid").all() as Row[]).map((r) => ({
    pid: r["pid"] as number,
    kind: r["kind"] as string,
    runId: (r["run_id"] as string | null) ?? null,
    taskId: (r["task_id"] as string | null) ?? null,
    procStartTicks: r["proc_start_ticks"] as number,
    pgid: r["pgid"] as number,
    generation: r["generation"] as number,
  }));
}

export function listSessions(db: DatabaseSync, runId: string): SessionRow[] {
  return (db.prepare("SELECT actor_owner, incarnation, generation FROM sessions WHERE run_id=? ORDER BY actor_owner").all(runId) as Row[]).map((r) => ({
    actorOwner: r["actor_owner"] as string,
    incarnation: r["incarnation"] as number,
    generation: r["generation"] as number,
  }));
}

export function countActionsForTask(db: DatabaseSync, runId: string, taskId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE run_id=? AND task_id=?").get(runId, taskId) as { n: number }).n;
}

export function unreconciledForActor(db: DatabaseSync, runId: string, actorOwner: string): ActionRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM actions WHERE run_id=? AND actor_owner=?
           AND state IN ('CLAIMING','CLAIMED','STALE_VIEW','EXECUTING','APPLIED','RELEASE_PENDING','RECOVERY_REQUIRED')`,
      )
      .all(runId, actorOwner) as Row[]
  ).map(toAction);
}

export function blockedPaths(db: DatabaseSync, runId: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT f.path AS path, a.action_id AS action_id FROM actions a JOIN action_files f
         ON f.run_id=a.run_id AND f.action_id=a.action_id
       WHERE a.run_id=? AND (a.state='RECOVERY_REQUIRED' OR a.registry_cleanup='UNVERIFIED')`,
    )
    .all(runId) as Row[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r["path"] as string) ?? [];
    list.push(r["action_id"] as string);
    out.set(r["path"] as string, list);
  }
  return out;
}

export function listEvents(db: DatabaseSync, runId: string, sinceSeq = 0): EventRow[] {
  return (db.prepare("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq").all(runId, sinceSeq) as Row[]).map((r) => ({
    runId: r["run_id"] as string,
    seq: r["seq"] as number,
    ts: r["ts"] as number,
    entity: r["entity"] as string,
    entityId: r["entity_id"] as string,
    fromState: (r["from_state"] as string | null) ?? null,
    toState: (r["to_state"] as string | null) ?? null,
    data: JSON.parse(r["data_json"] as string),
  }));
}
