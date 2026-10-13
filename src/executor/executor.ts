// Central executor (design §5, §7; plan 02). Models only propose: every mutation passes through
// here, with claims from Zoanthrope, digests from the journal, and a receipt that is decided by
// re-hashing the disk — never by what an agent says.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { type Edit, type RequestBody, requestDigest } from "../digest/canonical.ts";
import { PatchRejected, resolveEdits } from "../digest/edits.ts";
import { ABSENT, type Digest, type DigestOrAbsent, MAX_ACTION_FILE_BYTES, comparable, observeFile, sha256Bytes } from "../digest/file.ts";
import { type FailpointHook } from "../failpoints.ts";
import {
  type ActionFileRow,
  type ActionRow,
  type Journal,
  JournalError,
  type NewActionFile,
} from "../journal/journal.ts";
import { PathRejected, resolveInWorkspace, resolveSet, type WorkspacePath } from "../workspace/paths.ts";
import { type ClaimResult, type ClaimView, type RejoinResult, type ReleaseResult, ZooError } from "../zoo/types.ts";
import { absPath, commitFile, stageFile } from "./fs-applier.ts";
import { readFileSync } from "node:fs";

/** The slice of ZooAdapter the executor needs (lets tests wrap or break it). */
export interface ZooPort {
  claim(agent: string, files: readonly WorkspacePath[], intent: "read" | "edit", opts?: { purpose?: string; stamps?: { name: string; value: string }[] }): Promise<ClaimResult>;
  release(agent: string, files: readonly WorkspacePath[]): Promise<ReleaseResult>;
  listClaims(agent?: string): Promise<ClaimView[]>;
  rejoin(agent: string): Promise<RejoinResult>;
}

export interface TaskCtx {
  taskId: string;
  /** Paths an action of this task may change: exact files, or directories ending in "/". */
  scope: readonly string[];
  planRevision: number;
}

export interface ExecutorDeps {
  workspace: string;
  runId: string;
  journal: Journal;
  zoo: ZooPort;
  generation: number;
  failpoint?: FailpointHook;
  /** Test hook: called right before each rename, to assert INV1 from outside. */
  beforeRename?: (info: { actionId: string; actor: string; path: string }) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When true the agent-facing API refuses (RECOVERING) until `markRecovered()` is called by the
   * startup sequence (design §6: stop accepting old work until the run is reconciled).
   */
  requireRecovery?: boolean;
}

export type ActionStatus =
  | "SETTLED"
  | "APPLIED" // applied, release not finished
  | "WAITING_RESOURCE"
  | "STALE_VIEW"
  | "REJECTED"
  | "RECOVERY_REQUIRED"
  | "IN_PROGRESS"
  | "UNAVAILABLE";

export interface ActionReceipt {
  action_id: string;
  state: ActionRow["state"] | "UNKNOWN";
  status: ActionStatus;
  error_code: string | null;
  applied_files: { path: string; digest: DigestOrAbsent }[];
  observed_files: { path: string; digest: DigestOrAbsent | "other" }[];
  waiting: { holder: string; path: string; purpose: string | null; holder_stale: boolean } | null;
  cleanup: { registry: "CLEARED" | "UNVERIFIED" | null; fs: "NOT_ATTESTED" };
}

export type ReadOutcome =
  | { kind: "ok"; viewId: string; files: { path: string; digest: DigestOrAbsent; mode: number | null; content: string | null; binary: boolean }[] }
  | { kind: "waiting"; holder: string; path: string; purpose: string | null; holderStale: boolean }
  | { kind: "rejected"; code: string; detail?: string };

export type ProposeOutcome =
  | { kind: "ok"; actionId: string; requestDigest: Digest; files: { path: string; op: string; before: DigestOrAbsent; after: DigestOrAbsent }[] }
  | { kind: "rejected"; code: string; detail?: string };

const inScope = (path: string, scope: readonly string[]): boolean =>
  scope.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s));

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Executor {
  readonly #d: ExecutorDeps;
  readonly #root: string;
  readonly #tasks = new Map<string, TaskCtx>();
  readonly #inflight = new Map<string, Promise<ActionReceipt>>();
  #recovered: boolean;

  constructor(deps: ExecutorDeps) {
    this.#d = deps;
    this.#recovered = !deps.requireRecovery;
    this.#root = realpathSync(deps.workspace);
  }

  markRecovered(): void {
    this.#recovered = true;
  }
  get recovered(): boolean {
    return this.#recovered;
  }

  // ---- identity ---------------------------------------------------------------------------

  /** Zoo identity for writes. Derived by the backend; a model never chooses it. */
  actorOf(taskId: string): string {
    return `${this.#d.runId}:${taskId}`;
  }
  /** Distinct Zoo identity for reads: a read+release must never drop the actor's own edit claim. */
  readerOf(taskId: string): string {
    return `${this.actorOf(taskId)}#r`;
  }

  /** Admit a task: creates its session (incarnation 1) or bumps it after a restart. */
  beginSession(task: TaskCtx, model = "unspecified", bump = false): { actorOwner: string; incarnation: number } {
    this.#tasks.set(task.taskId, task);
    const actor = this.actorOf(task.taskId);
    const incarnation = this.#d.journal.tx((t) => t.upsertSession(this.#d.runId, actor, this.#d.generation, model, bump));
    return { actorOwner: actor, incarnation };
  }

  #task(taskId: string, incarnation: number): TaskCtx | { reject: string } {
    const task = this.#tasks.get(taskId);
    if (!task) return { reject: "UNKNOWN_TASK" };
    const cur = this.#d.journal.getSessionIncarnation(this.actorOf(taskId));
    if (cur === null) return { reject: "NO_SESSION" };
    if (cur !== incarnation) return { reject: "STALE_INCARNATION" };
    return task;
  }

  // ---- read_files -------------------------------------------------------------------------

  async readFiles(taskId: string, incarnation: number, paths: readonly string[]): Promise<ReadOutcome> {
    if (!this.#recovered) return { kind: "rejected", code: "RECOVERING" };
    const task = this.#task(taskId, incarnation);
    if ("reject" in task) return { kind: "rejected", code: task.reject };
    let files: WorkspacePath[];
    try {
      files = resolveSet(this.#root, paths);
    } catch (e) {
      if (e instanceof PathRejected) return { kind: "rejected", code: `PATH_${e.code}`, detail: e.input };
      throw e;
    }
    if (files.length === 0) return { kind: "rejected", code: "EMPTY" };

    // Reading a file in the middle of our own write would hand the model a half-applied view.
    const mine = new Set<string>();
    for (const a of this.#d.journal.unreconciledForActor(this.actorOf(taskId))) {
      for (const f of this.#d.journal.getActionFiles(a.actionId)) mine.add(f.path);
    }
    const clash = files.find((f) => mine.has(f));
    if (clash) return { kind: "rejected", code: "BUSY_OWN_ACTION", detail: clash };

    const reader = this.readerOf(taskId);
    let claim: ClaimResult;
    try {
      claim = await this.#d.zoo.claim(reader, files, "read", { purpose: `read_files ${taskId}` });
    } catch (e) {
      if (e instanceof ZooError) return { kind: "rejected", code: "COORDINATION_UNAVAILABLE", detail: e.kind };
      throw e;
    }
    if (claim.kind === "conflict") {
      const c = claim.conflict;
      return { kind: "waiting", holder: c.holder, path: c.path, purpose: c.purpose, holderStale: c.holderStale };
    }
    try {
      const rows: { path: string; digest: DigestOrAbsent; mode: number | null; blobRef: string | null }[] = [];
      const out: Extract<ReadOutcome, { kind: "ok" }>["files"] = [];
      for (const p of files) {
        const o = observeFile(absPath(this.#root, p));
        if (o.kind === "other") return { kind: "rejected", code: "NOT_REGULAR_FILE", detail: p };
        if (o.kind === "absent") {
          rows.push({ path: p, digest: ABSENT, mode: null, blobRef: null });
          out.push({ path: p, digest: ABSENT, mode: null, content: null, binary: false });
          continue;
        }
        if (o.size > MAX_ACTION_FILE_BYTES) return { kind: "rejected", code: "FILE_TOO_LARGE", detail: p };
        const bytes = readFileSync(absPath(this.#root, p));
        const digest = sha256Bytes(bytes);
        if (digest !== o.digest) return { kind: "rejected", code: "CHANGED_DURING_READ", detail: p };
        const blobRef = this.#d.journal.artifacts.put(bytes);
        let content: string | null = null;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          /* binary */
        }
        rows.push({ path: p, digest, mode: o.mode, blobRef });
        out.push({ path: p, digest, mode: o.mode, content, binary: content === null });
      }
      const viewId = `view-${randomUUID()}`;
      this.#d.journal.tx((t) => t.insertView(this.#d.runId, viewId, taskId, rows));
      return { kind: "ok", viewId, files: out };
    } finally {
      // best effort: a read claim that cannot be released is an orphan that recovery cleans (plan 04 §4)
      try {
        await this.#d.zoo.release(reader, files);
      } catch (e) {
        if (!(e instanceof ZooError)) throw e;
      }
    }
  }

  // ---- propose_patch (PREPARE) -------------------------------------------------------------

  async proposePatch(
    taskId: string,
    incarnation: number,
    viewId: string | readonly string[],
    edits: readonly Edit[],
    declaredOutputs: readonly string[] = [],
  ): Promise<ProposeOutcome> {
    if (!this.#recovered) return { kind: "rejected", code: "RECOVERING" };
    const task = this.#task(taskId, incarnation);
    if ("reject" in task) return { kind: "rejected", code: task.reject };
    // Several reads may be involved; each path keeps the digest of the view the agent actually saw
    // (the most recent one if it was read twice), so STALE_VIEW still works per file.
    const merged = new Map<string, { path: string; digest: string; mode: number | null; blobRef: string | null }>();
    for (const id of typeof viewId === "string" ? [viewId] : viewId) {
      const v = this.#d.journal.getView(id);
      if (!v || v.taskId !== taskId) return { kind: "rejected", code: "UNKNOWN_VIEW" };
      for (const f of v.files) merged.set(f.path, f);
    }
    const view = { taskId, files: [...merged.values()] };
    if (edits.length === 0) return { kind: "rejected", code: "EMPTY_PATCH" };

    // 1. containment + scope BEFORE anything touches Zoanthrope (S10/S15)
    const canon: Edit[] = [];
    try {
      for (const e of edits) {
        const path = resolveInWorkspace(this.#root, e.path);
        if (!inScope(path, task.scope)) return { kind: "rejected", code: "OUT_OF_SCOPE", detail: path };
        canon.push({ ...e, path });
      }
    } catch (e) {
      if (e instanceof PathRejected) return { kind: "rejected", code: `PATH_${e.code}`, detail: e.input };
      throw e;
    }

    // 2. resolve edits to final bytes against what the agent actually read
    const viewBytes = new Map<string, Buffer | null>();
    const expected: { path: string; digest: DigestOrAbsent }[] = [];
    const touched = new Set(canon.map((e) => e.path));
    for (const f of view.files) {
      if (!touched.has(f.path)) continue;
      viewBytes.set(f.path, f.blobRef ? this.#d.journal.artifacts.get(f.blobRef) : null);
      expected.push({ path: f.path, digest: f.digest as DigestOrAbsent });
    }
    let resolved;
    try {
      resolved = resolveEdits(viewBytes, canon);
    } catch (e) {
      if (e instanceof PatchRejected) return { kind: "rejected", code: e.code, detail: e.path };
      throw e;
    }

    // 3. persist: blobs first, then one transaction with the action and its files
    const body: RequestBody = {
      task_id: taskId,
      plan_revision: task.planRevision,
      expected_files: expected,
      edits: canon,
      declared_outputs: [...declaredOutputs],
    };
    const digest = requestDigest(body);
    const viewMeta = new Map(view.files.map((f) => [f.path, f]));
    const outcome = this.#d.journal.tx((t) => {
      const n = this.#d.journal.countActionsForTask(taskId) + 1;
      const actionId = `act-${taskId}-${n}`;
      const files: NewActionFile[] = resolved.map((r, i) => {
        const vm = viewMeta.get(r.path);
        const afterBlob = r.after === null ? null : this.#d.journal.artifacts.put(r.after);
        return {
          path: r.path,
          op: r.op,
          beforeDigest: r.before === null ? null : sha256Bytes(r.before),
          afterDigest: r.after === null ? null : sha256Bytes(r.after),
          beforeMode: vm?.mode ?? null,
          afterMode: r.op === "delete" ? null : (vm?.mode ?? 0o644),
          beforeBlob: vm?.blobRef as Digest | null,
          afterBlob,
          tmpName: `.synapser-tmp-${actionId}-${i}`,
        };
      });
      const res = t.insertAction(
        {
          runId: this.#d.runId,
          actionId,
          taskId,
          actorOwner: this.actorOf(taskId),
          incarnation,
          planRevision: task.planRevision,
          requestDigest: digest,
        },
        files,
      );
      return { res, actionId, files };
    });
    if (outcome.res.kind !== "created") return { kind: "rejected", code: "ACTION_ID_COLLISION" };
    await this.#fp("after-prepare-commit", outcome.actionId);
    return {
      kind: "ok",
      actionId: outcome.actionId,
      requestDigest: digest,
      files: outcome.files.map((f) => ({
        path: f.path,
        op: f.op,
        before: (f.beforeDigest ?? ABSENT) as DigestOrAbsent,
        after: (f.afterDigest ?? ABSENT) as DigestOrAbsent,
      })),
    };
  }

  // ---- apply_action ------------------------------------------------------------------------

  getAction(actionId: string): ActionReceipt {
    return this.#receipt(actionId);
  }

  /**
   * Idempotent on (run_id, action_id). A repeated call with the same digest returns the recorded
   * outcome without touching the disk or Zoanthrope; a different body under the same key is refused.
   */
  async applyAction(
    req: { actionId: string; requestDigest: Digest; incarnation: number },
    opts: { maxAttempts?: number; backoffMs?: number } = {},
  ): Promise<ActionReceipt> {
    if (!this.#recovered) return this.#rejected(req.actionId, "RECOVERING");
    const row = this.#d.journal.getAction(req.actionId);
    if (!row) return this.#rejected(req.actionId, "ACTION_ID_UNKNOWN");
    if (row.requestDigest !== req.requestDigest) return this.#rejected(req.actionId, "ACTION_ID_REUSED", row);
    const cur = this.#d.journal.getSessionIncarnation(row.actorOwner);
    if (cur !== req.incarnation) return this.#rejected(req.actionId, "STALE_INCARNATION", row);

    const running = this.#inflight.get(req.actionId);
    if (running) return running; // same action, same outcome: join the in-flight attempt
    const p = this.#drive(req.actionId, opts).finally(() => this.#inflight.delete(req.actionId));
    this.#inflight.set(req.actionId, p);
    return p;
  }

  async #drive(actionId: string, opts: { maxAttempts?: number; backoffMs?: number }): Promise<ActionReceipt> {
    const max = opts.maxAttempts ?? 1;
    const sleep = this.#d.sleep ?? defaultSleep;
    for (let attempt = 1; ; attempt++) {
      const r = await this.#attempt(actionId);
      if (r.status !== "WAITING_RESOURCE" || attempt >= max) return r;
      await sleep((opts.backoffMs ?? 50) * 2 ** (attempt - 1));
    }
  }

  async #attempt(actionId: string): Promise<ActionReceipt> {
    const a = this.#d.journal.getAction(actionId) as ActionRow;
    if (a.state !== "PREPARED" && a.state !== "WAITING_RESOURCE") return this.#receipt(actionId);
    const files = this.#d.journal.getActionFiles(actionId);
    const paths = files.map((f) => f.path as WorkspacePath);

    // recovery-blocked files and the one-unreconciled-action-per-actor rule (plan 02)
    const blocked = this.#d.journal.blockedPaths();
    const hit = paths.find((p) => blocked.has(p));
    if (hit) {
      this.#d.journal.tx((t) => t.transition(a.runId, actionId, a.state, "REJECTED", { errorCode: "BLOCKED_BY_RECOVERY", event: { path: hit, by: blocked.get(hit) } }));
      return this.#receipt(actionId);
    }
    if (this.#d.journal.unreconciledForActor(a.actorOwner).some((o) => o.actionId !== actionId)) {
      return { ...this.#receipt(actionId), status: "WAITING_RESOURCE", error_code: "BUSY_OWN_ACTION" };
    }

    // 2. ACQUIRE — the intent is durable BEFORE we call Zoanthrope (decision 3)
    this.#d.journal.tx((t) => t.transition(a.runId, actionId, a.state, "CLAIMING", { bumpAttempt: true, errorCode: null }));
    await this.#fp("after-claim-intent", actionId);
    let claim: ClaimResult;
    try {
      claim = await this.#d.zoo.claim(a.actorOwner, paths, "edit", {
        purpose: `action ${actionId}`,
        stamps: files.map((f) => ({ name: `digest:${f.path}`, value: f.beforeDigest ?? ABSENT })),
      });
    } catch (e) {
      if (e instanceof ZooError) {
        // No grant, no write. State stays CLAIMING: a claim may exist; recovery reconciles it.
        return { ...this.#receipt(actionId), status: "UNAVAILABLE", error_code: `COORDINATION_${e.kind}` };
      }
      throw e;
    }
    if (claim.kind === "conflict") {
      const c = claim.conflict;
      this.#d.journal.tx((t) =>
        t.transition(a.runId, actionId, "CLAIMING", "WAITING_RESOURCE", {
          errorCode: "RESOURCE_BUSY",
          event: { holder: c.holder, path: c.path, purpose: c.purpose, holder_stale: c.holderStale, reason: c.reason },
        }),
      );
      return {
        ...this.#receipt(actionId),
        waiting: { holder: c.holder, path: c.path, purpose: c.purpose, holder_stale: c.holderStale },
      };
    }
    await this.#fp("after-zoo-grant", actionId);
    this.#d.journal.tx((t) => t.transition(a.runId, actionId, "CLAIMING", "CLAIMED"));
    await this.#fp("after-claimed-commit", actionId);

    return this.#fromClaimed(actionId);
  }

  /** Steps 3–6 from a CLAIMED action. Also the entry point recovery uses (plan 04 §3). */
  async #fromClaimed(actionId: string): Promise<ActionReceipt> {
    const a = this.#d.journal.getAction(actionId) as ActionRow;
    const files = this.#d.journal.getActionFiles(actionId);
    const paths = files.map((f) => f.path as WorkspacePath);

    // 3. VERIFY — a granted claim does not validate content read earlier
    const mismatches: { path: string; expected: string; observed: string }[] = [];
    for (const f of files) {
      const o = comparable(observeFile(absPath(this.#root, f.path)));
      const want = f.beforeDigest ?? ABSENT;
      if (o !== want) mismatches.push({ path: f.path, expected: want, observed: o ?? "other" });
    }
    if (mismatches.length) {
      this.#d.journal.tx((t) => t.transition(a.runId, actionId, "CLAIMED", "STALE_VIEW", { errorCode: "STALE_VIEW", event: { mismatches } }));
      await this.#fp("after-stale-view", actionId);
      return this.#release(actionId, a, paths, "STALE_VIEW");
    }

    // 4. APPLY
    this.#d.journal.tx((t) => t.transition(a.runId, actionId, "CLAIMED", "EXECUTING"));
    await this.#fp("after-executing-commit", actionId);
    return this.#fromExecuting(actionId);
  }

  /** Steps 4–6 from an EXECUTING action; `#apply` skips files that already hold their result. */
  async #fromExecuting(actionId: string): Promise<ActionReceipt> {
    const a = this.#d.journal.getAction(actionId) as ActionRow;
    const files = this.#d.journal.getActionFiles(actionId);
    const paths = files.map((f) => f.path as WorkspacePath);
    const failed = await this.#apply(a, files);
    if (failed) return failed;

    // 5. CONFIRM — only after the last re-hash matched every predicted result
    await this.#fp("after-last-rename", actionId);
    const applied = files.map((f) => ({ path: f.path, digest: (f.afterDigest ?? ABSENT) as DigestOrAbsent }));
    this.#d.journal.tx((t) => t.transition(a.runId, actionId, "EXECUTING", "APPLIED", { receipt: { applied_files: applied } }));
    await this.#fp("after-applied-before-reply", actionId);

    // 6. RELEASE
    return this.#release(actionId, a, paths, "APPLIED");
  }

  // ---- entry points for recovery (src/executor/recovery.ts); not part of the agent API ----------

  resumeFromClaimed(actionId: string): Promise<ActionReceipt> {
    return this.#fromClaimed(actionId);
  }
  resumeExecuting(actionId: string): Promise<ActionReceipt> {
    return this.#fromExecuting(actionId);
  }
  /** From APPLIED or STALE_VIEW: move to RELEASE_PENDING and release. */
  resumeRelease(actionId: string, from: "APPLIED" | "STALE_VIEW"): Promise<ActionReceipt> {
    const a = this.#d.journal.getAction(actionId) as ActionRow;
    const paths = this.#d.journal.getActionFiles(actionId).map((f) => f.path as WorkspacePath);
    return this.#release(actionId, a, paths, from);
  }
  /** From RELEASE_PENDING: the transition already happened; only the release remains. */
  resumeReleasePending(actionId: string): Promise<ActionReceipt> {
    const a = this.#d.journal.getAction(actionId) as ActionRow;
    const paths = this.#d.journal.getActionFiles(actionId).map((f) => f.path as WorkspacePath);
    return this.#finishRelease(actionId, a, paths);
  }

  async #apply(a: ActionRow, files: ActionFileRow[]): Promise<ActionReceipt | null> {
    let n = 0;
    for (const f of files) {
      // Resume: a file that already holds its predicted result is not touched again.
      const already = comparable(observeFile(absPath(this.#root, f.path)));
      if (already === (f.afterDigest ?? ABSENT) && f.progress === "PENDING" && (f.beforeDigest ?? ABSENT) !== (f.afterDigest ?? ABSENT)) {
        this.#d.journal.tx((t) => t.markFileApplied(a.runId, a.actionId, f.path, already === ABSENT ? null : (already as Digest)));
        n++;
        continue;
      }
      if (already === (f.afterDigest ?? ABSENT) && f.progress === "APPLIED") {
        n++;
        continue;
      }
      // Last line of defense (recovery review #1): a claim does not validate content. Whatever
      // we are about to replace must be exactly what we predicted; otherwise write NOTHING.
      const about = comparable(observeFile(absPath(this.#root, f.path)));
      if (about !== (f.beforeDigest ?? ABSENT) && about !== (f.afterDigest ?? ABSENT)) {
        return this.#recoveryRequired(a, "OBSERVED_FOREIGN_CONTENT", {
          path: f.path,
          expected_before: f.beforeDigest ?? ABSENT,
          observed: about ?? "other",
          evidence: this.#preserve(f.path),
        });
      }
      const w = {
        path: f.path,
        op: f.op,
        after: f.afterBlob ? this.#d.journal.artifacts.get(f.afterBlob) : null,
        afterMode: f.afterMode,
        tmpName: f.tmpName as string,
      };
      try {
        const staged = stageFile(this.#root, w);
        await this.#fp("after-temp-written", a.actionId);
        await this.#d.beforeRename?.({ actionId: a.actionId, actor: a.actorOwner, path: f.path });
        commitFile(this.#root, w, staged);
        if (n === 0) await this.#fp("after-first-rename", a.actionId);
        else await this.#fp("between-renames", a.actionId);
      } catch (e) {
        if (e instanceof JournalError) throw e;
        if ((e as Error)?.name === "SimulatedCrash") throw e;
        return this.#recoveryRequired(a, "FS_ERROR", { path: f.path, error: String((e as Error)?.message ?? e) });
      }
      const seen = comparable(observeFile(absPath(this.#root, f.path)));
      const want = f.afterDigest ?? ABSENT;
      if (seen !== want) {
        return this.#recoveryRequired(a, "WRITE_MISMATCH", { path: f.path, expected: want, observed: seen ?? "other" });
      }
      this.#d.journal.tx((t) => t.markFileApplied(a.runId, a.actionId, f.path, seen === ABSENT ? null : (seen as Digest)));
      n++;
    }
    return null;
  }

  /** Copy the bytes currently on disk into the artifact store (evidence; never overwritten). */
  #preserve(path: string): string | null {
    const o = observeFile(absPath(this.#root, path));
    if (o.kind !== "file" || o.size > MAX_ACTION_FILE_BYTES) return null;
    return this.#d.journal.artifacts.put(readFileSync(absPath(this.#root, path)));
  }

  #recoveryRequired(a: ActionRow, code: string, detail: Record<string, unknown>): ActionReceipt {
    this.#d.journal.tx((t) => t.transition(a.runId, a.actionId, "EXECUTING", "RECOVERY_REQUIRED", { errorCode: code, event: detail }));
    return this.#receipt(a.actionId);
  }

  async #release(actionId: string, a: ActionRow, paths: WorkspacePath[], from: "APPLIED" | "STALE_VIEW"): Promise<ActionReceipt> {
    this.#d.journal.tx((t) => t.transition(a.runId, actionId, from, "RELEASE_PENDING"));
    await this.#fp("after-release-pending", actionId);
    return this.#finishRelease(actionId, a, paths);
  }

  async #finishRelease(actionId: string, a: ActionRow, paths: WorkspacePath[]): Promise<ActionReceipt> {
    let rel: ReleaseResult;
    try {
      rel = await this.#d.zoo.release(a.actorOwner, paths);
    } catch (e) {
      if (e instanceof ZooError) {
        // Result stays valid; cleanup is simply not certified, and the files stay blocked (S16).
        this.#d.journal.tx((t) => t.event(a.runId, "action", actionId, "RELEASE_PENDING", "RELEASE_PENDING", { release_error: e.kind }));
        return { ...this.#receipt(actionId), status: "UNAVAILABLE", error_code: `COORDINATION_${e.kind}`, cleanup: { registry: "UNVERIFIED", fs: "NOT_ATTESTED" } };
      }
      throw e;
    }
    await this.#fp("after-zoo-release", actionId);
    const cleanup = rel.registryCleanup === "CLEARED" && rel.stillHeld.length === 0 ? "CLEARED" : "UNVERIFIED";
    this.#d.journal.tx((t) =>
      t.transition(a.runId, actionId, "RELEASE_PENDING", "SETTLED", {
        registryCleanup: cleanup,
        event: { released: rel.released, still_held: rel.stillHeld },
      }),
    );
    return this.#receipt(actionId);
  }

  // ---- receipts ----------------------------------------------------------------------------

  #rejected(actionId: string, code: string, row?: ActionRow): ActionReceipt {
    return {
      action_id: actionId,
      state: row?.state ?? "UNKNOWN",
      status: "REJECTED",
      error_code: code,
      applied_files: [],
      observed_files: [],
      waiting: null,
      cleanup: { registry: row?.registryCleanup ?? null, fs: "NOT_ATTESTED" },
    };
  }

  #receipt(actionId: string): ActionReceipt {
    const a = this.#d.journal.getAction(actionId);
    if (!a) return this.#rejected(actionId, "ACTION_ID_UNKNOWN");
    const files = this.#d.journal.getActionFiles(actionId);
    const status: ActionStatus =
      a.state === "SETTLED"
        ? a.errorCode === "STALE_VIEW"
          ? "STALE_VIEW"
          : "SETTLED"
        : a.state === "APPLIED" || a.state === "RELEASE_PENDING"
          ? "APPLIED"
          : a.state === "WAITING_RESOURCE"
            ? "WAITING_RESOURCE"
            : a.state === "REJECTED"
              ? "REJECTED"
              : a.state === "RECOVERY_REQUIRED"
                ? "RECOVERY_REQUIRED"
                : "IN_PROGRESS";
    const done = a.state === "APPLIED" || a.state === "RELEASE_PENDING" || (a.state === "SETTLED" && a.errorCode !== "STALE_VIEW");
    return {
      action_id: actionId,
      state: a.state,
      status,
      error_code: a.errorCode,
      applied_files: done ? files.map((f) => ({ path: f.path, digest: (f.afterDigest ?? ABSENT) as DigestOrAbsent })) : [],
      observed_files: files.map((f) => {
        const o = comparable(observeFile(absPath(this.#root, f.path)));
        return { path: f.path, digest: o ?? "other" };
      }),
      waiting: null,
      cleanup: { registry: a.registryCleanup, fs: "NOT_ATTESTED" },
    };
  }

  async #fp(name: Parameters<FailpointHook>[0], actionId: string): Promise<void> {
    await this.#d.failpoint?.(name, { actionId });
  }
}
