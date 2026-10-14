// WorkflowManager: the lifecycle of workflows (plan 13 §4). A workflow is persisted as ledger events in
// its own run journal (`<state>/<workflow id>/`), so everything the UI, CLI and MCP show about it is the
// same hash-chained record. The manager owns ONLY the lifecycle: validation, state machine, start
// policy, single-flight per workspace (one executor may write a workspace), cancellation. HOW a
// workflow is executed is an injected `WorkflowEngine`.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { digestOfJson } from "../digest/canonical.ts";
import { Journal } from "../journal/journal.ts";
import { approvalStatus, requestApproval } from "../orchestration/gates.ts";
import { validateWorkflow, type Workflow, type WorkflowState } from "./model.ts";

export interface Actor {
  id: string;
  role: "initiator" | "operator" | "system";
}

export interface EngineRun {
  workflow: () => Workflow;
  revision: () => number;
  journal: Journal;
  runId: string;
  signal: AbortSignal;
  /** The engine reports lifecycle changes; the manager validates them against the state machine. */
  mark: (state: WorkflowState, data?: Record<string, unknown>) => void;
}
export interface EngineResult {
  status: "DONE" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  reason: string | null;
}
export interface WorkflowEngine {
  run(r: EngineRun): Promise<EngineResult>;
}

const LEGAL: Record<WorkflowState, readonly WorkflowState[]> = {
  DRAFT: ["AWAITING_START", "PLANNING", "CANCELLED"],
  AWAITING_START: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["VERIFYING", "DONE", "FAILED", "CANCELLED"],
  VERIFYING: ["RUNNING", "DONE", "FAILED", "CANCELLED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};
export const isTerminal = (s: WorkflowState): boolean => LEGAL[s].length === 0;

export interface WorkflowView {
  id: string;
  state: WorkflowState;
  reason: string | null;
  revision: number;
  workflow: Workflow;
  createdBy: string | null;
  conditions: { id: string; statement: string; required: boolean; waived: boolean; status: string | null; evidence: string | null; detail: string | null }[];
  round: number;
  events: number;
}

export type Result<T> = ({ ok: true } & T) | { ok: false; code: string; errors?: string[] };

export interface ManagerOptions {
  stateDir: string;
  workspaceRoot: string;
  commandIds: ReadonlySet<string>;
  profileIds?: ReadonlySet<string>;
  engine: WorkflowEngine;
  /** When true, starting needs an explicit operator decision (a gate keyed `start`). */
  startRequiresApproval?: boolean;
  /** Poll period for the start gate, ms. */
  pollMs?: number;
}

const newId = (): string => `wf-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

export class WorkflowManager {
  readonly #o: ManagerOptions;
  readonly #journals = new Map<string, Journal>();
  readonly #running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  readonly #queue: string[] = [];
  #closed = false;

  constructor(o: ManagerOptions) {
    this.#o = o;
  }

  // ---- persistence helpers ----------------------------------------------------------------------

  #journal(id: string, create = false): Journal | null {
    const held = this.#journals.get(id);
    if (held) return held;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) return null;
    if (!create && !existsSync(join(this.#o.stateDir, id, "journal.db"))) return null;
    const j = Journal.open(this.#o.stateDir, id);
    this.#journals.set(id, j);
    return j;
  }

  #writeDoc(j: Journal, w: Workflow, revision: number, by: Actor): void {
    const blob = j.artifacts.put(Buffer.from(JSON.stringify(w), "utf8"));
    j.tx((t) => t.event(j.runId, "workflow_doc", w.id, null, `REV${revision}`, { revision, blob, digest: digestOfJson(JSON.parse(JSON.stringify(w))), by: by.id, role: by.role }));
  }

  #doc(j: Journal): { workflow: Workflow; revision: number; createdBy: string | null } | null {
    const evs = j.listEvents().filter((e) => e.entity === "workflow_doc");
    const last = evs.at(-1);
    if (!last) return null;
    const d = last.data as { blob: string; revision: number };
    const first = evs[0]!.data as { by?: string };
    return { workflow: JSON.parse(j.artifacts.get(d.blob).toString("utf8")) as Workflow, revision: d.revision, createdBy: first.by ?? null };
  }

  #state(j: Journal): { state: WorkflowState; reason: string | null } {
    const last = j.listEvents().filter((e) => e.entity === "workflow").at(-1);
    if (!last) return { state: "DRAFT", reason: null };
    return { state: last.toState as WorkflowState, reason: ((last.data as { reason?: string }).reason ?? null) as string | null };
  }

  #transition(j: Journal, to: WorkflowState, by: string, data: Record<string, unknown> = {}): boolean {
    const cur = this.#state(j).state;
    if (!LEGAL[cur].includes(to)) return false;
    j.tx((t) => t.event(j.runId, "workflow", j.runId, cur, to, { by, ...data }));
    return true;
  }

  // ---- API ---------------------------------------------------------------------------------------

  create(input: unknown, actor: Actor): Result<{ id: string }> {
    const raw = { ...(input as Record<string, unknown>) };
    if (raw["id"] === undefined) raw["id"] = newId();
    const v = validateWorkflow(raw, { workspaceRoot: this.#o.workspaceRoot, commandIds: this.#o.commandIds, ...(this.#o.profileIds ? { profileIds: this.#o.profileIds } : {}) });
    if (!v.ok) return { ok: false, code: "INVALID_WORKFLOW", errors: v.errors };
    if (existsSync(join(this.#o.stateDir, v.workflow.id))) return { ok: false, code: "ALREADY_EXISTS" };
    const j = this.#journal(v.workflow.id, true)!;
    this.#writeDoc(j, v.workflow, 1, actor);
    j.tx((t) => t.event(j.runId, "workflow", j.runId, null, "DRAFT", { by: actor.id }));
    return { ok: true, id: v.workflow.id };
  }

  /** Changing conditions is a REVISION (C2): allowed until the workflow is terminal; the next DONE must
   *  be judged against it (the engine reads the current revision on every evaluation round). */
  edit(id: string, input: unknown, actor: Actor): Result<{ revision: number }> {
    const j = this.#journal(id);
    if (!j) return { ok: false, code: "UNKNOWN_WORKFLOW" };
    const { state } = this.#state(j);
    if (isTerminal(state)) return { ok: false, code: "TERMINAL" };
    const cur = this.#doc(j)!;
    const v = validateWorkflow({ ...(input as Record<string, unknown>), id }, { workspaceRoot: this.#o.workspaceRoot, commandIds: this.#o.commandIds, ...(this.#o.profileIds ? { profileIds: this.#o.profileIds } : {}) });
    if (!v.ok) return { ok: false, code: "INVALID_WORKFLOW", errors: v.errors };
    const revision = cur.revision + 1;
    this.#writeDoc(j, v.workflow, revision, actor);
    return { ok: true, revision };
  }

  start(id: string, actor: Actor): Result<{ state: WorkflowState }> {
    const j = this.#journal(id);
    if (!j) return { ok: false, code: "UNKNOWN_WORKFLOW" };
    const { state } = this.#state(j);
    if (state !== "DRAFT" && state !== "AWAITING_START") return { ok: false, code: "NOT_STARTABLE" };
    if (this.#o.startRequiresApproval && actor.role !== "operator") {
      if (state === "DRAFT") this.#transition(j, "AWAITING_START", actor.id, { reason: "start requires an operator decision" });
      const digest = digestOfJson(JSON.parse(JSON.stringify(this.#doc(j)!.workflow)));
      requestApproval(j, id, "start", digest, "start the workflow");
      void this.#awaitStart(id, digest);
      return { ok: true, state: "AWAITING_START" };
    }
    this.#enqueue(id, actor.id);
    return { ok: true, state: this.#state(j).state };
  }

  async #awaitStart(id: string, digest: string): Promise<void> {
    const j = this.#journal(id)!;
    while (!this.#closed) {
      const st = approvalStatus(j, "start", digest);
      if (st === "APPROVED") return void this.#enqueue(id, "operator");
      if (st === "REJECTED") return void this.#transition(j, "CANCELLED", "operator", { reason: "start was rejected" });
      if (isTerminal(this.#state(j).state)) return;
      await new Promise((r) => setTimeout(r, this.#o.pollMs ?? 200));
    }
  }

  #enqueue(id: string, by: string): void {
    if (this.#queue.includes(id) || this.#running.has(id)) return;
    this.#queue.push(id);
    const j = this.#journal(id)!;
    if (this.#state(j).state === "DRAFT") this.#transition(j, "AWAITING_START", by, { reason: "queued" });
    this.#pump();
  }

  #pump(): void {
    // one executor may write a workspace at a time: workflows on the same workspace are serialised
    if (this.#running.size >= 1 || this.#queue.length === 0 || this.#closed) return;
    const id = this.#queue.shift()!;
    const j = this.#journal(id)!;
    if (isTerminal(this.#state(j).state)) return this.#pump();
    const abort = new AbortController();
    const done = (async () => {
      this.#transition(j, "PLANNING", "system");
      let res: EngineResult;
      try {
        res = await this.#o.engine.run({
          workflow: () => this.#doc(j)!.workflow,
          revision: () => this.#doc(j)!.revision,
          journal: j,
          runId: id,
          signal: abort.signal,
          mark: (state, data) => {
            this.#transition(j, state, "engine", data ?? {});
          },
        });
      } catch (e) {
        res = { status: "FAILED", reason: `engine error: ${String((e as Error).message ?? e).slice(0, 300)}` };
      }
      const final: WorkflowState = res.status === "DONE" ? "DONE" : res.status === "CANCELLED" ? "CANCELLED" : "FAILED";
      if (!isTerminal(this.#state(j).state)) {
        // an engine may have walked the machine itself; make sure the terminal state is recorded
        if (!this.#transition(j, final, "engine", { reason: res.reason })) {
          j.tx((t) => t.event(id, "workflow", id, this.#state(j).state, final, { by: "engine", reason: res.reason, forced: true }));
        }
      }
    })().finally(() => {
      this.#running.delete(id);
      this.#pump();
    });
    this.#running.set(id, { abort, done });
  }

  cancel(id: string, actor: Actor): Result<{ state: WorkflowState }> {
    const j = this.#journal(id);
    if (!j) return { ok: false, code: "UNKNOWN_WORKFLOW" };
    const { state } = this.#state(j);
    if (isTerminal(state)) return { ok: false, code: "TERMINAL" };
    const run = this.#running.get(id);
    const qi = this.#queue.indexOf(id);
    if (qi >= 0) this.#queue.splice(qi, 1);
    if (run) {
      j.tx((t) => t.event(id, "workflow_cancel", id, null, "REQUESTED", { by: actor.id }));
      run.abort.abort();
      return { ok: true, state };
    }
    this.#transition(j, "CANCELLED", actor.id, { reason: "cancelled before it ran" });
    return { ok: true, state: "CANCELLED" };
  }

  status(id: string): WorkflowView | null {
    const j = this.#journal(id);
    if (!j) return null;
    const doc = this.#doc(j);
    if (!doc) return null;
    const st = this.#state(j);
    const events = j.listEvents();
    const rounds = events.filter((e) => e.entity === "condition_round");
    const round = rounds.length ? Number(rounds.at(-1)!.entityId) : 0;
    const latest = new Map<string, { status: string; evidence: string; detail: string }>();
    for (const e of events.filter((x) => x.entity === "condition" && Number((x.data as { round?: number }).round) === round)) {
      const d = e.data as { evidence: string; detail: string };
      latest.set(e.entityId, { status: String(e.toState), evidence: d.evidence, detail: d.detail });
    }
    return {
      id, state: st.state, reason: st.reason, revision: doc.revision, workflow: doc.workflow, createdBy: doc.createdBy,
      conditions: doc.workflow.conditions.map((c) => ({
        id: c.id, statement: c.statement, required: c.required, waived: Boolean(c.waivedBy),
        status: latest.get(c.id)?.status ?? null, evidence: latest.get(c.id)?.evidence ?? null, detail: latest.get(c.id)?.detail ?? null,
      })),
      round,
      events: events.length,
    };
  }

  list(): WorkflowView[] {
    if (!existsSync(this.#o.stateDir)) return [];
    const out: WorkflowView[] = [];
    for (const n of readdirSync(this.#o.stateDir).sort()) {
      try {
        if (!statSync(join(this.#o.stateDir, n)).isDirectory()) continue;
        const v = this.status(n);
        if (v) out.push(v);
      } catch {
        /* not a workflow directory */
      }
    }
    return out;
  }

  events(id: string, sinceSeq = 0): { seq: number; ts: number; entity: string; id: string; to: string | null; data: unknown }[] | null {
    const j = this.#journal(id);
    if (!j) return null;
    return j
      .listEvents(sinceSeq)
      .filter((e) => !["approval_challenge"].includes(e.entity))
      .map((e) => ({ seq: e.seq, ts: e.ts, entity: e.entity, id: e.entityId, to: e.toState, data: e.data }));
  }

  /** Resolves when the workflow's execution (if any) has ended. Used by tests and shutdown. */
  async settled(id: string): Promise<void> {
    await this.#running.get(id)?.done;
  }

  journalOf(id: string): Journal | null {
    return this.#journal(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const r of this.#running.values()) r.abort.abort();
    await Promise.allSettled([...this.#running.values()].map((r) => r.done));
    for (const j of this.#journals.values()) j.close();
    this.#journals.clear();
  }
}
