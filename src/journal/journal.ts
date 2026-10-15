// SQLite journal (plan 01). State and its event are written in ONE transaction; transitions are
// compare-and-swap; a journal that cannot be written stops the next mutation (JournalError).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Digest } from "../digest/file.ts";
import { eventHash, genesisHash } from "../audit/chain.ts";
import { ArtifactStore } from "./artifacts.ts";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION, seedTransitionsSql } from "./schema.ts";
import { type ActionState, isLegalTransition } from "./transitions.ts";
import { env } from "../sim/env.ts";
import * as reads from "./reads.ts";

export class JournalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JournalError";
  }
}
export class TransitionConflict extends Error {
  readonly actual: ActionState | null;
  constructor(actionId: string, expected: ActionState, to: ActionState, actual: ActionState | null) {
    super(`action ${actionId}: expected state ${expected} (→ ${to}) but found ${actual ?? "<missing>"}`);
    this.name = "TransitionConflict";
    this.actual = actual;
  }
}
export class IllegalTransition extends Error {
  constructor(from: ActionState, to: ActionState) {
    super(`illegal action transition ${from} → ${to}`);
    this.name = "IllegalTransition";
  }
}

export interface NewAction {
  runId: string;
  actionId: string;
  taskId: string;
  actorOwner: string;
  incarnation: number;
  planRevision: number;
  requestDigest: Digest;
}
export interface NewActionFile {
  path: string;
  op: "create" | "replace" | "delete";
  beforeDigest: Digest | null;
  afterDigest: Digest | null;
  beforeMode: number | null;
  afterMode: number | null;
  beforeBlob: Digest | null;
  afterBlob: Digest | null;
  tmpName: string | null;
}
export interface ActionRow extends NewAction {
  state: ActionState;
  attempt: number;
  errorCode: string | null;
  receipt: unknown;
  registryCleanup: "CLEARED" | "UNVERIFIED" | null;
  fsCleanup: "NOT_ATTESTED";
  preparedAt: number;
  updatedAt: number;
}
export interface ActionFileRow extends NewActionFile {
  runId: string;
  actionId: string;
  progress: "PENDING" | "APPLIED";
  observedDigest: string | null;
}
export interface AgentRunInsert {
  agentRunId: string;
  runId: string;
  taskId: string | null;
  profileId: string;
  role: string;
  adapter: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  argv: string[];
  baseDigest: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  reason: string | null;
  sessionId: string | null;
  models: string[];
  usageProvenance: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  apiMs: number | null;
  networkIsolated: boolean;
  permissionDenials: number | null;
  promptBlob: string | null;
  stdoutBlob: string | null;
  stderrBlob: string | null;
  finalTextBlob: string | null;
  toolUse: Record<string, number> | null;
  skills?: { id: string; digest: string; mechanism: "native-dir" | "skills-dir-flag" | "prompt-prepend" }[];
  /** K4 (plan 17): the injected provider of this run, by name and endpoint only. Never a key value. */
  injection?: { provider: string; model: string; endpoint: string; keyVariable: string; protocol: string } | null;
  changes: { path: string; op: string; beforeDigest: string | null; afterDigest: string | null }[];
}
export interface ModelCallInsert {
  callId: string;
  runId: string;
  taskId: string | null;
  role: string;
  requestedModel: string;
  servedModel: string | null;
  baseUrl: string;
  startedAt: number;
  latencyMs: number | null;
  httpStatus: number | null;
  retries: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  fallbackUsed: boolean;
  costUsd: number | null;
  error: string | null;
  requestBlob: string | null;
  responseBlob: string | null;
}
export interface ChildRow {
  pid: number;
  kind: string;
  runId: string | null;
  taskId: string | null;
  /** Field 22 of /proc/<pid>/stat: identifies THIS process even if the pid is later reused. */
  procStartTicks: number;
  pgid: number;
  generation: number;
}
export interface SessionRow {
  actorOwner: string;
  incarnation: number;
  generation: number;
}
export interface EventRow {
  runId: string;
  seq: number;
  ts: number;
  entity: string;
  entityId: string;
  fromState: string | null;
  toState: string | null;
  data: unknown;
}

export type InsertOutcome =
  | { kind: "created" }
  | { kind: "duplicate"; state: ActionState; receipt: unknown }
  | { kind: "digest_conflict"; existingDigest: Digest };

export interface TransitionData {
  errorCode?: string | null;
  receipt?: unknown;
  registryCleanup?: "CLEARED" | "UNVERIFIED";
  /** Extra fields recorded on the event only. */
  event?: Record<string, unknown>;
  bumpAttempt?: boolean;
}

type Row = Record<string, unknown>;

export interface ResearchCallInsert {
  callId: string;
  runId: string;
  taskId: string | null;
  role: string;
  provider: string;
  /** null when the query was refused by the guard: its text is not stored, only its hash. */
  query: string | null;
  querySha256: string;
  params: Record<string, unknown>;
  startedAt: number;
  latencyMs: number | null;
  creditsUsed: number | null;
  cached: boolean;
  resultBlob: string | null;
  error: string | null;
  urls: string[];
}
export interface ResearchCallRow {
  callId: string;
  taskId: string | null;
  role: string;
  provider: string;
  query: string | null;
  querySha256: string;
  startedAt: number;
  latencyMs: number | null;
  creditsUsed: number | null;
  cached: boolean;
  resultBlob: string | null;
  error: string | null;
  urls: string[];
}

export class Tx {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  event(runId: string, entity: string, entityId: string, from: string | null, to: string | null, data: unknown = {}): number {
    const last = this.#db.prepare("SELECT seq, hash FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(runId) as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? genesisHash(runId);
    const ts = this.#now();
    const dataJson = JSON.stringify(data);
    const hash = eventHash(prev, { runId, seq, ts, entity, entityId, fromState: from, toState: to, dataJson });
    this.#db
      .prepare("INSERT INTO events(run_id,seq,ts,entity,entity_id,from_state,to_state,data_json,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(runId, seq, ts, entity, entityId, from, to, dataJson, prev, hash);
    return seq;
  }

  /** Idempotent by (run_id, action_id): same digest → duplicate, different body → digest_conflict. */
  insertAction(a: NewAction, files: readonly NewActionFile[]): InsertOutcome {
    const ex = this.#db
      .prepare("SELECT state, request_digest, receipt_json FROM actions WHERE run_id=? AND action_id=?")
      .get(a.runId, a.actionId) as Row | undefined;
    if (ex) {
      if (ex["request_digest"] !== a.requestDigest) {
        return { kind: "digest_conflict", existingDigest: ex["request_digest"] as Digest };
      }
      const r = ex["receipt_json"] as string | null;
      return { kind: "duplicate", state: ex["state"] as ActionState, receipt: r ? JSON.parse(r) : null };
    }
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO actions(run_id,action_id,task_id,actor_owner,incarnation,plan_revision,request_digest,state,prepared_at,updated_at)
         VALUES(?,?,?,?,?,?,?,'PREPARED',?,?)`,
      )
      .run(a.runId, a.actionId, a.taskId, a.actorOwner, a.incarnation, a.planRevision, a.requestDigest, now, now);
    const ins = this.#db.prepare(
      `INSERT INTO action_files(run_id,action_id,path,op,before_digest,after_digest,before_mode,after_mode,before_blob,after_blob,tmp_name)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const f of [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
      ins.run(a.runId, a.actionId, f.path, f.op, f.beforeDigest, f.afterDigest, f.beforeMode, f.afterMode, f.beforeBlob, f.afterBlob, f.tmpName);
    }
    this.event(a.runId, "action", a.actionId, null, "PREPARED", {
      task_id: a.taskId,
      actor_owner: a.actorOwner,
      incarnation: a.incarnation,
      request_digest: a.requestDigest,
      files: files.map((f) => f.path).sort(),
    });
    return { kind: "created" };
  }

  /** CAS: moves `from → to` or throws. Writes the event in the same transaction. */
  transition(runId: string, actionId: string, from: ActionState, to: ActionState, data: TransitionData = {}): void {
    if (!isLegalTransition(from, to)) throw new IllegalTransition(from, to);
    const r = this.#db
      .prepare(
        `UPDATE actions SET state=?, updated_at=?, attempt=attempt+?,
           error_code=CASE WHEN ? THEN ? ELSE error_code END,
           receipt_json=COALESCE(?, receipt_json),
           registry_cleanup=COALESCE(?, registry_cleanup)
         WHERE run_id=? AND action_id=? AND state=?`,
      )
      .run(
        to,
        this.#now(),
        data.bumpAttempt ? 1 : 0,
        data.errorCode !== undefined ? 1 : 0,
        data.errorCode ?? null,
        data.receipt !== undefined ? JSON.stringify(data.receipt) : null,
        data.registryCleanup ?? null,
        runId,
        actionId,
        from,
      );
    if (Number(r.changes) !== 1) {
      const cur = this.#db.prepare("SELECT state FROM actions WHERE run_id=? AND action_id=?").get(runId, actionId) as Row | undefined;
      throw new TransitionConflict(actionId, from, to, (cur?.["state"] as ActionState | undefined) ?? null);
    }
    this.event(runId, "action", actionId, from, to, {
      ...(data.errorCode ? { error_code: data.errorCode } : {}),
      ...(data.event ?? {}),
    });
  }

  markFileApplied(runId: string, actionId: string, path: string, observed: Digest | null): void {
    const r = this.#db
      .prepare("UPDATE action_files SET progress='APPLIED', observed_digest=? WHERE run_id=? AND action_id=? AND path=?")
      .run(observed, runId, actionId, path);
    if (Number(r.changes) !== 1) throw new JournalError(`no action_file ${actionId}:${path}`);
    this.event(runId, "action_file", `${actionId}:${path}`, "PENDING", "APPLIED", { observed });
  }

  /** Create the session (incarnation 1) or bump it after a restart. Never decreases. */
  upsertSession(runId: string, actorOwner: string, generation: number, model: string, bump: boolean): number {
    const cur = this.#db.prepare("SELECT incarnation FROM sessions WHERE run_id=? AND actor_owner=?").get(runId, actorOwner) as Row | undefined;
    if (!cur) {
      this.#db
        .prepare("INSERT INTO sessions(run_id,actor_owner,incarnation,generation,model,budget_json,state) VALUES(?,?,?,?,?,'{}','ACTIVE')")
        .run(runId, actorOwner, 1, generation, model);
      this.event(runId, "session", actorOwner, null, "ACTIVE", { incarnation: 1, generation });
      return 1;
    }
    const inc = (cur["incarnation"] as number) + (bump ? 1 : 0);
    if (bump) {
      this.#db.prepare("UPDATE sessions SET incarnation=?, generation=? WHERE run_id=? AND actor_owner=?").run(inc, generation, runId, actorOwner);
      this.event(runId, "session", actorOwner, "ACTIVE", "ACTIVE", { incarnation: inc, generation });
    }
    return inc;
  }

  insertView(
    runId: string,
    viewId: string,
    taskId: string,
    files: readonly { path: string; digest: string; mode: number | null; blobRef: string | null }[],
  ): void {
    const ins = this.#db.prepare("INSERT INTO views(view_id,run_id,task_id,path,digest,mode,blob_ref,taken_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const f of files) ins.run(viewId, runId, taskId, f.path, f.digest, f.mode, f.blobRef, this.#now());
    this.event(runId, "view", viewId, null, "TAKEN", { task_id: taskId, files: files.map((f) => f.path) });
  }

  insertMission(m: { runId: string; objective: string; repo: string; baseSha: string; planRevision: number; limits: unknown }): void {
    this.#db
      .prepare("INSERT INTO missions(run_id,objective,repo,base_sha,plan_revision,limits_json,state,created_at) VALUES(?,?,?,?,?,?,'DRAFT',?)")
      .run(m.runId, m.objective, m.repo, m.baseSha, m.planRevision, JSON.stringify(m.limits), this.#now());
    this.event(m.runId, "mission", m.runId, null, "DRAFT", { objective: m.objective });
  }
  insertPlanRevision(runId: string, revision: number, plan: unknown, accepted: boolean): void {
    this.#db
      .prepare("INSERT INTO plan_revisions(run_id,revision,plan_json,accepted_at) VALUES(?,?,?,?)")
      .run(runId, revision, JSON.stringify(plan), accepted ? this.#now() : null);
    this.event(runId, "plan", String(revision), null, accepted ? "ACCEPTED" : "PROPOSED", {});
  }
  /** Additive plan change: a node gains a dependency (e.g. the acceptance node waits for a new task). */
  addTaskDep(runId: string, taskId: string, dependsOn: string): void {
    this.#db.prepare("INSERT INTO task_deps(run_id,task_id,depends_on) VALUES(?,?,?)").run(runId, taskId, dependsOn);
    this.event(runId, "task_dep", taskId, null, "ADDED", { depends_on: dependsOn });
  }
  insertTask(t: { runId: string; taskId: string; actorOwner: string; priority: number; scope: string[]; spec: unknown; planRevision: number; deps: string[] }): void {
    this.#db
      .prepare("INSERT INTO tasks(run_id,task_id,actor_owner,state,priority,scope_json,criteria_json,plan_revision) VALUES(?,?,?,?,?,?,?,?)")
      .run(t.runId, t.taskId, t.actorOwner, "PENDING", t.priority, JSON.stringify(t.scope), JSON.stringify(t.spec), t.planRevision);
    const dep = this.#db.prepare("INSERT INTO task_deps(run_id,task_id,depends_on) VALUES(?,?,?)");
    for (const d of t.deps) dep.run(t.runId, t.taskId, d);
    this.event(t.runId, "task", t.taskId, null, "PENDING", { deps: t.deps, scope: t.scope });
  }
  setTaskState(runId: string, taskId: string, from: string, to: string, data: Record<string, unknown> = {}): void {
    const r = this.#db.prepare("UPDATE tasks SET state=? WHERE run_id=? AND task_id=? AND state=?").run(to, runId, taskId, from);
    if (Number(r.changes) !== 1) {
      const cur = this.#db.prepare("SELECT state FROM tasks WHERE run_id=? AND task_id=?").get(runId, taskId) as Row | undefined;
      throw new JournalError(`task ${taskId}: expected ${from}, found ${String(cur?.["state"] ?? "<missing>")}`);
    }
    this.event(runId, "task", taskId, from, to, data);
  }
  setMissionState(runId: string, from: string, to: string, data: Record<string, unknown> = {}): void {
    const r = this.#db.prepare("UPDATE missions SET state=? WHERE run_id=? AND state=?").run(to, runId, from);
    if (Number(r.changes) !== 1) throw new JournalError(`mission ${runId}: expected ${from}`);
    this.event(runId, "mission", runId, from, to, data);
  }
  insertValidation(v: { validationId: string; runId: string; taskId: string; command: string; snapshotDigest: string; scopeDigest: string }): void {
    this.#db
      .prepare("INSERT INTO validations(validation_id,run_id,task_id,command,snapshot_digest,scope_digest,started_at) VALUES(?,?,?,?,?,?,?)")
      .run(v.validationId, v.runId, v.taskId, v.command, v.snapshotDigest, v.scopeDigest, this.#now());
  }
  finishValidation(validationId: string, runId: string, r: { exitCode: number | null; outputBlob: string | null; valid: boolean; note?: string }): void {
    this.#db
      .prepare("UPDATE validations SET exit_code=?, output_blob=?, valid=?, finished_at=? WHERE validation_id=?")
      .run(r.exitCode, r.outputBlob, r.valid ? 1 : 0, this.#now(), validationId);
    this.event(runId, "validation", validationId, "RUNNING", r.valid && r.exitCode === 0 ? "PASSED" : "FAILED", {
      exit_code: r.exitCode,
      valid: r.valid,
      ...(r.note ? { note: r.note } : {}),
    });
  }

  insertAgentRun(r: AgentRunInsert): void {
    this.#db
      .prepare(
        `INSERT INTO agent_runs(agent_run_id,run_id,task_id,profile_id,role,adapter,started_at,finished_at,duration_ms,argv_json,base_digest,
           exit_code,signal,timed_out,outcome,reason,session_id,models_json,usage_provenance,input_tokens,output_tokens,cache_read_tokens,
           cache_write_tokens,reasoning_tokens,cost_usd,turns,api_ms,network_isolated,permission_denials,prompt_blob,stdout_blob,stderr_blob,
           final_text_blob,tool_use_json,changes_json,skills_json,injection_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.agentRunId, r.runId, r.taskId, r.profileId, r.role, r.adapter, r.startedAt, r.finishedAt, r.durationMs, JSON.stringify(r.argv), r.baseDigest,
        r.exitCode, r.signal, r.timedOut ? 1 : 0, r.outcome, r.reason, r.sessionId, JSON.stringify(r.models), r.usageProvenance, r.inputTokens,
        r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.reasoningTokens, r.costUsd, r.turns, r.apiMs, r.networkIsolated ? 1 : 0,
        r.permissionDenials, r.promptBlob, r.stdoutBlob, r.stderrBlob, r.finalTextBlob, r.toolUse === null ? null : JSON.stringify(r.toolUse), JSON.stringify(r.changes),
        JSON.stringify(r.skills ?? []), r.injection ? JSON.stringify(r.injection) : null,
      );
    this.event(r.runId, "agent_run", r.agentRunId, null, r.outcome, {
      profile: r.profileId,
      role: r.role,
      task_id: r.taskId,
      duration_ms: r.durationMs,
      usage_provenance: r.usageProvenance,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cost_usd: r.costUsd,
      changed_files: r.changes.map((c) => c.path),
      tool_use: r.toolUse,
      skills: r.skills ?? [],
      ...(r.reason ? { reason: r.reason } : {}),
    });
  }

  insertModelCall(c: ModelCallInsert): void {
    this.#db
      .prepare(
        `INSERT INTO model_calls(call_id,run_id,task_id,role,requested_model,served_model,base_url,started_at,latency_ms,http_status,
           retries,prompt_tokens,completion_tokens,reasoning_tokens,finish_reason,fallback_used,cost_usd,error,request_blob,response_blob)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.callId, c.runId, c.taskId, c.role, c.requestedModel, c.servedModel, c.baseUrl, c.startedAt, c.latencyMs, c.httpStatus,
        c.retries, c.promptTokens, c.completionTokens, c.reasoningTokens, c.finishReason, c.fallbackUsed ? 1 : 0, c.costUsd, c.error,
        c.requestBlob, c.responseBlob,
      );
    this.event(c.runId, "model_call", c.callId, null, c.error ? "FAILED" : "OK", {
      task_id: c.taskId,
      role: c.role,
      requested_model: c.requestedModel,
      served_model: c.servedModel,
      latency_ms: c.latencyMs,
      prompt_tokens: c.promptTokens,
      completion_tokens: c.completionTokens,
      cost_usd: c.costUsd,
      fallback_used: c.fallbackUsed,
      ...(c.error ? { error: c.error } : {}),
    });
  }

  insertResearchCall(c: ResearchCallInsert): void {
    this.#db
      .prepare(
        `INSERT INTO research_calls(call_id,run_id,task_id,role,provider,query,query_sha256,params_json,started_at,latency_ms,credits_used,cached,result_blob,error,urls_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.callId, c.runId, c.taskId, c.role, c.provider, c.query, c.querySha256, JSON.stringify(c.params), c.startedAt, c.latencyMs,
        c.creditsUsed, c.cached ? 1 : 0, c.resultBlob, c.error, JSON.stringify(c.urls),
      );
    this.event(c.runId, "research_call", c.callId, null, c.error ? "FAILED" : "OK", {
      task_id: c.taskId,
      role: c.role,
      provider: c.provider,
      query: c.query,
      query_sha256: c.querySha256,
      urls: c.urls,
      credits_used: c.creditsUsed,
      cached: c.cached,
      ...(c.error ? { error: c.error } : {}),
    });
  }

  registerChild(c: ChildRow): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO children(pid,kind,run_id,task_id,proc_start_ticks,pgid,started_at,generation) VALUES(?,?,?,?,?,?,?,?)")
      .run(c.pid, c.kind, c.runId, c.taskId, c.procStartTicks, c.pgid, this.#now(), c.generation);
  }
  removeChild(pid: number): void {
    this.#db.prepare("DELETE FROM children WHERE pid=?").run(pid);
  }

  recordObservation(runId: string, actionId: string, path: string, observed: string | null): void {
    this.#db
      .prepare("UPDATE action_files SET observed_digest=? WHERE run_id=? AND action_id=? AND path=?")
      .run(observed, runId, actionId, path);
  }
}

export interface JournalOptions {
  now?: () => number;
}

export class Journal {
  readonly runId: string;
  readonly dir: string;
  readonly artifacts: ArtifactStore;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #inTx = false;

  private constructor(runId: string, dir: string, db: DatabaseSync, now: () => number) {
    this.runId = runId;
    this.dir = dir;
    this.#db = db;
    this.#now = now;
    this.artifacts = new ArtifactStore(join(dir, "artifacts"));
  }

  /** `<stateDir>/<runId>/journal.db`. Creates the schema on first open; verifies it afterwards. */
  static open(stateDir: string, runId: string, opts: JournalOptions = {}): Journal {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new JournalError(`invalid run_id ${JSON.stringify(runId)}`);
    const dir = join(stateDir, runId);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "journal.db"), { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL");
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA trusted_schema=OFF");
      const jm = (db.prepare("PRAGMA journal_mode").get() as Row)["journal_mode"];
      if (jm !== "wal") throw new JournalError(`journal_mode is ${String(jm)}, expected wal`);
      const qc = (db.prepare("PRAGMA quick_check").get() as Row)["quick_check"];
      if (qc !== "ok") throw new JournalError(`quick_check failed: ${String(qc)}`);
      const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get();
      if (!hasMeta) {
        db.exec("BEGIN IMMEDIATE");
        db.exec(SCHEMA_SQL);
        db.exec(seedTransitionsSql());
        db.prepare("INSERT INTO meta VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
        db.exec("COMMIT");
      } else {
        const v = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as Row | undefined)?.["value"];
        const version = Number(v);
        if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
          throw new JournalError(`schema_version ${String(v)} is not supported (current ${SCHEMA_VERSION})`);
        }
        if (version < SCHEMA_VERSION) {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (let from = version; from < SCHEMA_VERSION; from += 1) {
              const sql = MIGRATIONS[from];
              if (!sql) throw new JournalError(`missing migration from schema_version ${from}`);
              db.exec(sql);
              db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(from + 1));
            }
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        }
      }
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw e instanceof JournalError ? e : new JournalError(`cannot open journal: ${String(e)}`, e);
    }
    // The clock is read at each event, through the simulated environment when a test installs one (plan 18 H11.1).
    return new Journal(runId, dir, db, opts.now ?? (() => env.now()));
  }

  /** BEGIN IMMEDIATE … COMMIT; rolls back on any throw. Not reentrant. */
  tx<T>(fn: (t: Tx) => T): T {
    if (this.#inTx) throw new JournalError("nested transaction");
    this.#inTx = true;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      this.#inTx = false;
      throw new JournalError(`cannot begin transaction: ${String(e)}`, e);
    }
    try {
      const out = fn(new Tx(this.#db, this.#now));
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* the connection may already have rolled back */
      }
      if (e instanceof TransitionConflict || e instanceof IllegalTransition || e instanceof JournalError) throw e;
      throw new JournalError(`journal transaction failed: ${String((e as Error)?.message ?? e)}`, e);
    } finally {
      this.#inTx = false;
    }
  }

  // ---- reads -----------------------------------------------------------------------------

  getAction(actionId: string): ActionRow | null {
    return reads.getAction(this.#db, this.runId, actionId);
  }
  getActionFiles(actionId: string): ActionFileRow[] {
    return reads.getActionFiles(this.#db, this.runId, actionId);
  }
  /** Actions that are not SETTLED/REJECTED, oldest first (recovery order). */
  listNonTerminal(): ActionRow[] {
    return reads.listNonTerminal(this.#db, this.runId);
  }
  getSessionIncarnation(actorOwner: string): number | null {
    return reads.getSessionIncarnation(this.#db, this.runId, actorOwner);
  }
  getView(viewId: string): { taskId: string; files: { path: string; digest: string; mode: number | null; blobRef: string | null }[] } | null {
    return reads.getView(this.#db, this.runId, viewId);
  }
  listResearchCalls(): ResearchCallRow[] {
    return reads.listResearchCalls(this.#db, this.runId);
  }

  listModelCalls(): { callId: string; taskId: string | null; startedAt: number; latencyMs: number | null; role: string; requestedModel: string; servedModel: string | null; promptTokens: number | null;
    completionTokens: number | null; costUsd: number | null; error: string | null; requestBlob: string | null; responseBlob: string | null; fallbackUsed: boolean; retries: number }[] {
    return reads.listModelCalls(this.#db, this.runId);
  }

  /** Raw event rows, in order, with their chain fields (for verification and export). */
  eventChain(): import("../audit/chain.ts").ChainEvent[] {
    return reads.eventChain(this.#db, this.runId);
  }
  getMission(): { objective: string; state: string; planRevision: number } | null {
    return reads.getMission(this.#db, this.runId);
  }
  listAllActions(): ActionRow[] {
    return reads.listAllActions(this.#db, this.runId);
  }

  getMissionState(): string | null {
    return reads.getMissionState(this.#db, this.runId);
  }
  listPlanRevisions(): { revision: number; plan: any; acceptedAt: number | null }[] {
    return reads.listPlanRevisions(this.#db, this.runId);
  }
  listTasks(): { taskId: string; actorOwner: string; state: string; priority: number; scope: string[]; spec: any; deps: string[] }[] {
    return reads.listTasks(this.#db, this.runId);
  }
  listValidations(): { validationId: string; taskId: string; command: string; snapshotDigest: string; exitCode: number | null; valid: boolean; outputBlob: string | null; startedAt: number; finishedAt: number | null }[] {
    return reads.listValidations(this.#db, this.runId);
  }

  listAgentRuns(): (AgentRunInsert & { outcome: string })[] {
    return reads.listAgentRuns(this.#db, this.runId);
  }

  listChildren(): ChildRow[] {
    return reads.listChildren(this.#db, this.runId);
  }
  listSessions(): SessionRow[] {
    return reads.listSessions(this.#db, this.runId);
  }
  countActionsForTask(taskId: string): number {
    return reads.countActionsForTask(this.#db, this.runId, taskId);
  }
  /** Actions of `actorOwner` that may hold claims or have touched files (everything past PREPARED, not settled). */
  unreconciledForActor(actorOwner: string): ActionRow[] {
    return reads.unreconciledForActor(this.#db, this.runId, actorOwner);
  }
  /** Files of actions that must block new work on them (plan 04 §5). */
  blockedPaths(): Map<string, string[]> {
    return reads.blockedPaths(this.#db, this.runId);
  }

  listEvents(sinceSeq = 0): EventRow[] {
    return reads.listEvents(this.#db, this.runId, sinceSeq);
  }

  /** Raw access for tests that must prove the database itself rejects something. */
  get rawForTests(): DatabaseSync {
    return this.#db;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
