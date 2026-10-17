// Subtasks requested by agents (plan 10 §5, invariant W5). An agent never creates an agent: it ASKS,
// and the request becomes an ADDITIVE plan revision only if the same validator that accepts a
// supervisor's plan accepts it, plus the rules that make delegation safe:
//   scope ⊆ requester's scope · depth ≤ maxDepth · bounded breadth · inside budget · not too late.
// A rejection has no side effect on the plan; both outcomes are ledger events.

import type { Violation } from "../audit/invariants.ts";
import { type Plan, type PlanTask, validatePlan } from "../mission/plan.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProfileCard, StepKind } from "./catalog.ts";

export interface SubtaskAsk {
  objective: string;
  kind?: StepKind;
  scope: string[];
  criteria: string[];
  /** Why the requester needs it. Recorded as the AGENT'S assertion, never as evidence. */
  why: string;
  profile?: string;
  tags?: string[];
}

export type DelegationCode =
  | "NOT_RUNNING"
  | "TOO_DEEP"
  | "TOO_MANY_TASKS"
  | "TOO_MANY_PER_TASK"
  | "SCOPE_ESCAPE"
  | "DUPLICATE"
  | "TOO_LATE"
  | "INVALID";

export type DelegationResult =
  | { ok: true; taskId: string; revision: number; depth: number }
  | { ok: false; code: DelegationCode; detail: string };

export interface DelegationPort {
  request(requesterTaskId: string, ask: SubtaskAsk): DelegationResult;
}

/** An actor that is not the requesting agent (the coordinator's advisor): same rules, no "must be running". */
export interface DelegationAsOptions {
  actor: string;
}

export interface DelegationConfig {
  /** Longest chain requester → child → grandchild…; configurable per workflow. */
  maxDepth: number;
  /** Total agent tasks the plan may hold (including delegated ones). */
  maxTasks: number;
  /** Subtasks one task may request. */
  maxPerTask: number;
}
export const DEFAULT_DELEGATION: DelegationConfig = { maxDepth: 2, maxTasks: 12, maxPerTask: 3 };

const within = (child: string, parentScope: readonly string[]): boolean =>
  parentScope.some((p) => (p.endsWith("/") ? child.startsWith(p) : child === p));

type StoredTask = PlanTask & { depth?: number; requestedBy?: string; why?: string };

export class DelegationBroker implements DelegationPort {
  readonly #journal: Journal;
  readonly #runId: string;
  readonly #cfg: DelegationConfig;
  readonly #workspaceRoot: string;
  readonly #catalog: readonly ProfileCard[] | undefined;
  readonly #budgetUsd: number | undefined;

  constructor(o: { journal: Journal; runId: string; workspaceRoot: string; config?: Partial<DelegationConfig>; catalog?: readonly ProfileCard[]; budgetUsd?: number }) {
    this.#journal = o.journal;
    this.#runId = o.runId;
    this.#workspaceRoot = o.workspaceRoot;
    this.#cfg = { ...DEFAULT_DELEGATION, ...(o.config ?? {}) };
    this.#catalog = o.catalog;
    this.#budgetUsd = o.budgetUsd;
  }

  get config(): DelegationConfig {
    return this.#cfg;
  }

  request(requesterTaskId: string, ask: SubtaskAsk): DelegationResult {
    return this.#request(requesterTaskId, ask, false);
  }

  /** The advisor splitting a task that is not running (plan 13 §6.2 `replan`). Same validation. */
  requestAs(parentTaskId: string, ask: SubtaskAsk, o: DelegationAsOptions): DelegationResult {
    void o;
    return this.#request(parentTaskId, ask, true);
  }

  #request(requesterTaskId: string, ask: SubtaskAsk, system: boolean): DelegationResult {
    const res = this.#decide(requesterTaskId, ask, system);
    // the ledger sees attempts as well as acceptances; the agent's `why` is labelled as asserted
    this.#journal.tx((t) =>
      t.event(this.#runId, "delegation", res.ok ? res.taskId : `${requesterTaskId}-rejected`, null, res.ok ? "ACCEPTED" : "REJECTED", {
        requester: requesterTaskId,
        objective: ask.objective.slice(0, 300),
        scope: ask.scope,
        kind: ask.kind ?? "write",
        asserted_why: String(ask.why).slice(0, 500),
        max_depth: this.#cfg.maxDepth,
        ...(res.ok ? { revision: res.revision, depth: res.depth } : { code: res.code, detail: res.detail.slice(0, 300) }),
      }),
    );
    return res;
  }

  #decide(requesterId: string, ask: SubtaskAsk, system = false): DelegationResult {
    const tasks = this.#journal.listTasks();
    const requester = tasks.find((t) => t.taskId === requesterId);
    if (!requester || (!system && requester.state !== "RUNNING")) return { ok: false, code: "NOT_RUNNING", detail: "only a running task can request a subtask" };

    const depth = ((requester.spec.depth as number | undefined) ?? 0) + 1;
    if (depth > this.#cfg.maxDepth) return { ok: false, code: "TOO_DEEP", detail: `delegation depth ${depth} exceeds the limit of ${this.#cfg.maxDepth}` };

    const mine = tasks.filter((t) => t.spec.requested_by === requesterId);
    if (mine.length >= this.#cfg.maxPerTask) return { ok: false, code: "TOO_MANY_PER_TASK", detail: `a task may request at most ${this.#cfg.maxPerTask} subtasks` };

    const kind = ask.kind ?? "write";
    for (const s of ask.scope) {
      if (!within(s, requester.scope)) return { ok: false, code: "SCOPE_ESCAPE", detail: `"${s}" is outside the requester's scope` };
    }
    if (mine.some((t) => t.spec.objective === ask.objective && JSON.stringify(t.scope) === JSON.stringify(ask.scope))) {
      return { ok: false, code: "DUPLICATE", detail: "an identical subtask was already requested" };
    }
    // the acceptance node must still be waiting, or the new work could never be accepted
    const gate = tasks.find((t) => t.spec.kind === "validation" && t.state === "PENDING");
    if (!gate) return { ok: false, code: "TOO_LATE", detail: "acceptance has already started" };

    const revs = this.#journal.listPlanRevisions().filter((r) => r.acceptedAt !== null);
    const last = revs[revs.length - 1];
    if (!last) return { ok: false, code: "INVALID", detail: "no accepted plan to extend" };
    const base = last.plan as { tasks: StoredTask[] };
    if (base.tasks.length >= this.#cfg.maxTasks) return { ok: false, code: "TOO_MANY_TASKS", detail: `the plan already holds ${base.tasks.length} tasks (limit ${this.#cfg.maxTasks})` };

    let n = mine.length + 1;
    let taskId = "";
    for (;;) {
      taskId = `${requesterId.slice(0, 28)}-s${n}`;
      if (!tasks.some((t) => t.taskId === taskId)) break;
      n++;
    }
    const gates = (requester.spec.gates as "approval"[] | undefined) ?? [];
    const child: StoredTask = {
      id: taskId,
      objective: ask.objective,
      scope: ask.scope,
      criteria: ask.criteria,
      context: (requester.spec.context as string[] | undefined) ?? [],
      deps: [],
      priority: requester.priority,
      kind,
      ...(ask.profile ? { profile: ask.profile } : {}),
      ...(ask.tags ? { tags: ask.tags } : {}),
      // a delegated step may not slip past a gate its requester sits behind
      ...(gates.length ? { gates } : {}),
    };

    // The SAME validator that accepts a supervisor's plan accepts this revision.
    const check = validatePlan(
      { tasks: [...base.tasks, child] },
      { workspaceRoot: this.#workspaceRoot, maxTasks: this.#cfg.maxTasks, ...(this.#catalog ? { catalog: this.#catalog } : {}), ...(this.#budgetUsd !== undefined ? { budgetUsd: this.#budgetUsd } : {}) },
    );
    if (!check.ok) return { ok: false, code: "INVALID", detail: check.errors.join("; ") };

    // Additive BY CONSTRUCTION: earlier tasks are carried over verbatim; only the child is new.
    // (validatePlan normalizes defaults, so its output is for judging, not for storing.)
    const stored: StoredTask[] = [...base.tasks, { ...child, depth, requestedBy: requesterId, why: String(ask.why).slice(0, 500) }];
    const revision = last.revision + 1;
    const plan: Plan = { tasks: stored };
    this.#journal.tx((t) => {
      t.insertPlanRevision(this.#runId, revision, plan, true);
      t.insertTask({
        runId: this.#runId,
        taskId,
        actorOwner: `${this.#runId}:${taskId}`,
        priority: requester.priority,
        scope: ask.scope,
        spec: {
          kind: "agent",
          objective: ask.objective,
          criteria: ask.criteria,
          context: child.context ?? [],
          step: kind,
          ...(ask.profile ? { profile: ask.profile } : {}),
          ...(ask.tags ? { tags: ask.tags } : {}),
          ...(gates.length ? { gates } : {}),
          // Recipe MCP selection is system-injected into the requester. Delegation inherits it verbatim;
          // the agent's request schema has no field that can widen or replace this capability boundary.
          ...(Array.isArray(requester.spec.mcpToolSelection) ? { mcpToolSelection: requester.spec.mcpToolSelection } : {}),
          depth,
          requested_by: requesterId,
        },
        planRevision: revision,
        deps: [],
      });
      t.addTaskDep(this.#runId, gate.taskId, taskId);
    });
    return { ok: true, taskId, revision, depth };
  }
}

/** W5 over the ledger: revisions are additive; every added task is a valid, in-scope, in-depth delegation. */
export function checkDelegation(journal: Journal): Violation[] {
  const out: Violation[] = [];
  const revs = journal.listPlanRevisions().filter((r) => r.acceptedAt !== null);
  const tasks = journal.listTasks();
  const accepted = new Map(
    journal
      .listEvents()
      .filter((e) => e.entity === "delegation" && e.toState === "ACCEPTED")
      .map((e) => [e.entityId, e.data as Record<string, unknown>]),
  );
  for (let i = 1; i < revs.length; i++) {
    const prev = (revs[i - 1] as { plan: { tasks: StoredTask[] } }).plan.tasks;
    const cur = (revs[i] as { plan: { tasks: StoredTask[] }; revision: number }).plan.tasks;
    for (const p of prev) {
      const c = cur.find((x) => x.id === p.id);
      if (!c || JSON.stringify(c) !== JSON.stringify(p)) {
        out.push({ invariant: "W5", code: "REVISION_NOT_ADDITIVE", where: p.id, detail: { revision: (revs[i] as { revision: number }).revision } });
      }
    }
    for (const c of cur.filter((x) => !prev.some((p) => p.id === x.id))) {
      const rev = (revs[i] as { revision: number }).revision;
      const req = c.requestedBy;
      const parent = tasks.find((t) => t.taskId === req);
      const ev = accepted.get(c.id);
      if (!req || !parent) {
        out.push({ invariant: "W5", code: "ADDED_WITHOUT_REQUESTER", where: c.id, detail: { revision: rev } });
        continue;
      }
      if (!ev) out.push({ invariant: "W5", code: "NO_DELEGATION_EVENT", where: c.id, detail: { revision: rev } });
      const maxDepth = Number(ev?.["max_depth"] ?? Number.POSITIVE_INFINITY);
      if ((c.depth ?? 0) > maxDepth) out.push({ invariant: "W5", code: "TOO_DEEP", where: c.id, detail: { depth: c.depth, maxDepth } });
      for (const s of c.scope) {
        if (!within(s, parent.scope)) out.push({ invariant: "W5", code: "SCOPE_ESCAPE", where: c.id, detail: { path: s, requester: req } });
      }
    }
  }
  // the acceptance node must wait for every delegated task
  const validators = tasks.filter((t) => t.spec.kind === "validation");
  for (const t of tasks.filter((x) => x.spec.requested_by)) {
    if (!validators.some((v) => v.deps.includes(t.taskId))) {
      out.push({ invariant: "W5", code: "NOT_UNDER_ACCEPTANCE", where: t.taskId, detail: {} });
    }
  }
  return out;
}
