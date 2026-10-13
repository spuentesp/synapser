// SQLite journal (plan 01). State and its event are written in ONE transaction; transitions are
// compare-and-swap; a journal that cannot be written stops the next mutation (JournalError).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Digest } from "../digest/file.ts";
import { ArtifactStore } from "./artifacts.ts";
import { SCHEMA_SQL, SCHEMA_VERSION, seedTransitionsSql } from "./schema.ts";
import { type ActionState, isLegalTransition } from "./transitions.ts";

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

export class Tx {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  event(runId: string, entity: string, entityId: string, from: string | null, to: string | null, data: unknown = {}): number {
    const seq = (this.#db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE run_id=?").get(runId) as { n: number }).n;
    this.#db
      .prepare("INSERT INTO events(run_id,seq,ts,entity,entity_id,from_state,to_state,data_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(runId, seq, this.#now(), entity, entityId, from, to, JSON.stringify(data));
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
        if (v !== String(SCHEMA_VERSION)) throw new JournalError(`schema_version ${String(v)} != ${SCHEMA_VERSION}`);
      }
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw e instanceof JournalError ? e : new JournalError(`cannot open journal: ${String(e)}`, e);
    }
    return new Journal(runId, dir, db, opts.now ?? Date.now);
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
    const r = this.#db.prepare("SELECT * FROM actions WHERE run_id=? AND action_id=?").get(this.runId, actionId) as Row | undefined;
    return r ? toAction(r) : null;
  }
  getActionFiles(actionId: string): ActionFileRow[] {
    return (this.#db.prepare("SELECT * FROM action_files WHERE run_id=? AND action_id=? ORDER BY path").all(this.runId, actionId) as Row[]).map(toFile);
  }
  /** Actions that are not SETTLED/REJECTED, oldest first (recovery order). */
  listNonTerminal(): ActionRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM actions WHERE run_id=? AND state NOT IN ('SETTLED','REJECTED') ORDER BY prepared_at, action_id")
        .all(this.runId) as Row[]
    ).map(toAction);
  }
  getSessionIncarnation(actorOwner: string): number | null {
    const r = this.#db.prepare("SELECT incarnation FROM sessions WHERE run_id=? AND actor_owner=?").get(this.runId, actorOwner) as Row | undefined;
    return r ? (r["incarnation"] as number) : null;
  }
  getView(viewId: string): { taskId: string; files: { path: string; digest: string; mode: number | null; blobRef: string | null }[] } | null {
    const rows = this.#db.prepare("SELECT * FROM views WHERE run_id=? AND view_id=? ORDER BY path").all(this.runId, viewId) as Row[];
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
  listChildren(): ChildRow[] {
    return (this.#db.prepare("SELECT * FROM children ORDER BY pid").all() as Row[]).map((r) => ({
      pid: r["pid"] as number,
      kind: r["kind"] as string,
      runId: (r["run_id"] as string | null) ?? null,
      taskId: (r["task_id"] as string | null) ?? null,
      procStartTicks: r["proc_start_ticks"] as number,
      pgid: r["pgid"] as number,
      generation: r["generation"] as number,
    }));
  }
  listSessions(): SessionRow[] {
    return (this.#db.prepare("SELECT actor_owner, incarnation, generation FROM sessions WHERE run_id=? ORDER BY actor_owner").all(this.runId) as Row[]).map((r) => ({
      actorOwner: r["actor_owner"] as string,
      incarnation: r["incarnation"] as number,
      generation: r["generation"] as number,
    }));
  }
  countActionsForTask(taskId: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM actions WHERE run_id=? AND task_id=?").get(this.runId, taskId) as { n: number }).n;
  }
  /** Actions of `actorOwner` that may hold claims or have touched files (everything past PREPARED, not settled). */
  unreconciledForActor(actorOwner: string): ActionRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM actions WHERE run_id=? AND actor_owner=?
             AND state IN ('CLAIMING','CLAIMED','STALE_VIEW','EXECUTING','APPLIED','RELEASE_PENDING','RECOVERY_REQUIRED')`,
        )
        .all(this.runId, actorOwner) as Row[]
    ).map(toAction);
  }
  /** Files of actions that must block new work on them (plan 04 §5). */
  blockedPaths(): Map<string, string[]> {
    const rows = this.#db
      .prepare(
        `SELECT f.path AS path, a.action_id AS action_id FROM actions a JOIN action_files f
           ON f.run_id=a.run_id AND f.action_id=a.action_id
         WHERE a.run_id=? AND (a.state='RECOVERY_REQUIRED' OR a.registry_cleanup='UNVERIFIED')`,
      )
      .all(this.runId) as Row[];
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r["path"] as string) ?? [];
      list.push(r["action_id"] as string);
      out.set(r["path"] as string, list);
    }
    return out;
  }

  listEvents(sinceSeq = 0): EventRow[] {
    return (this.#db.prepare("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq").all(this.runId, sinceSeq) as Row[]).map((r) => ({
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

  /** Raw access for tests that must prove the database itself rejects something. */
  get rawForTests(): DatabaseSync {
    return this.#db;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
