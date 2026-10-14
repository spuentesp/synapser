// Live state of the swarm as a PURE FUNCTION of the ledger (plan 11 §4, invariants L1/L2).
//   swarmState(journal, atSeq?)  →  the same bytes for the same events, at any point in history.
// It reads ledger events only: not the file system, not Zoanthrope. What Zoanthrope contributes
// arrives as `zoo_observation` events and is shown apart (`observedHeld`), never mixed into facts.

import type { Journal } from "../journal/journal.ts";

export type AgentStatus = "planned" | "waiting_approval" | "ready" | "running" | "waiting" | "validating" | "done" | "failed" | "cancelled";

export interface AgentState {
  taskId: string;
  status: AgentStatus;
  profile: string | null;
  kind: string | null;
  depth: number;
  requestedBy: string | null;
  steps: number;
  tools: Record<string, number>;
  lastSeq: number;
  currentAction: { actionId: string; state: string } | null;
  waitingOn: { holder: string; path: string; sinceSeq: number } | null;
  /** Files of this task's own actions that are claimed or being written (ledger facts). */
  heldFiles: string[];
  /** Files Zoanthrope's audit shows claimed and not yet released by this task's actor (an observation). */
  observedHeld: string[];
  /** Per-run accounting from agent_run events (the same source as the `cost` query). */
  runs: { n: number; inputTokens: number; outputTokens: number; usd: number; usdUnknownRuns: number };
  /** Model calls seen so far, including those of a run still in flight. */
  modelCalls: { n: number; promptTokens: number; completionTokens: number; usd: number; unpricedCalls: number };
  searches: number;
}

export interface SwarmState {
  atSeq: number;
  mission: { state: string | null; planRevision: number };
  agents: AgentState[];
  pendingApprovals: string[];
  alerts: { taskId: string; code: string; profile: string | null }[];
  zoo: { observations: number; gaps: number };
  delegations: { accepted: number; rejected: number };
}

const TERMINAL_ACTION = new Set(["SETTLED", "REJECTED", "STALE_VIEW"]);

export function swarmState(journal: Journal, atSeq = Number.POSITIVE_INFINITY): SwarmState {
  const runId = journal.runId;
  const events = journal.listEvents().filter((e) => e.seq <= atSeq);
  const agents = new Map<string, AgentState>();
  const get = (id: string): AgentState => {
    let a = agents.get(id);
    if (!a) {
      a = {
        taskId: id, status: "planned", profile: null, kind: null, depth: 0, requestedBy: null, steps: 0, tools: {}, lastSeq: 0,
        currentAction: null, waitingOn: null, heldFiles: [], observedHeld: [],
        runs: { n: 0, inputTokens: 0, outputTokens: 0, usd: 0, usdUnknownRuns: 0 },
        modelCalls: { n: 0, promptTokens: 0, completionTokens: 0, usd: 0, unpricedCalls: 0 },
        searches: 0,
      };
      agents.set(id, a);
    }
    return a;
  };
  const actionTask = new Map<string, string>();
  const actionFiles = new Map<string, string[]>();
  const actionState = new Map<string, string>();
  const approval = new Map<string, string>();
  const observed = new Map<string, Set<string>>();
  let missionState: string | null = null;
  let planRevision = 0;
  let observations = 0;
  let gaps = 0;
  const alerts: SwarmState["alerts"] = [];
  const del = { accepted: 0, rejected: 0 };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const taskOfActor = (actor: string): string | null => (actor.startsWith(`${runId}:`) ? actor.slice(runId.length + 1).replace(/#r$/, "") : null);

  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.entity) {
      case "mission":
        missionState = e.toState;
        break;
      case "plan":
        if (e.toState === "ACCEPTED") planRevision = Math.max(planRevision, Number(e.entityId));
        break;
      case "task": {
        const a = get(e.entityId);
        a.lastSeq = e.seq;
        const t = e.toState;
        a.status =
          t === "RUNNING" ? "running" : t === "READY" ? "ready" : t === "VALIDATING" ? "validating" : t === "DONE" ? "done" : t === "FAILED" ? "failed" : t === "CANCELLED" ? "cancelled" : "planned";
        if (t !== "RUNNING") a.waitingOn = null;
        break;
      }
      case "dispatch": {
        const a = get(e.entityId);
        a.profile = String(d["profile"]);
        a.kind = String(d["kind"]);
        a.lastSeq = e.seq;
        break;
      }
      case "delegation":
        if (e.toState === "ACCEPTED") {
          del.accepted++;
          const a = get(e.entityId);
          a.requestedBy = String(d["requester"]);
          a.depth = num(d["depth"]);
        } else del.rejected++;
        break;
      case "approval":
        approval.set(e.entityId, e.toState ?? "");
        get(e.entityId);
        break;
      case "alert":
        alerts.push({ taskId: e.entityId, code: e.toState ?? "", profile: typeof d["profile"] === "string" ? (d["profile"] as string) : null });
        break;
      case "agent_step": {
        const a = get(e.entityId);
        a.steps++;
        a.lastSeq = e.seq;
        const tool = d["tool"];
        if (typeof tool === "string") a.tools[tool] = (a.tools[tool] ?? 0) + 1;
        break;
      }
      case "action": {
        if (e.toState === "PREPARED" && e.fromState === null) {
          const task = String(d["task_id"]);
          actionTask.set(e.entityId, task);
          actionFiles.set(e.entityId, ((d["files"] as string[] | undefined) ?? []).slice().sort());
        }
        if (e.toState) actionState.set(e.entityId, e.toState);
        const task = actionTask.get(e.entityId);
        if (task) {
          const a = get(task);
          a.lastSeq = e.seq;
          if (e.toState === "WAITING_RESOURCE") {
            a.status = "waiting";
            a.waitingOn = { holder: String(d["holder"] ?? "?"), path: String(d["path"] ?? "?"), sinceSeq: e.seq };
          } else if (a.status === "waiting" && e.toState && e.toState !== "WAITING_RESOURCE") {
            a.status = "running";
            a.waitingOn = null;
          }
        }
        break;
      }
      case "agent_run": {
        const task = d["task_id"];
        if (typeof task === "string") {
          const a = get(task);
          a.runs.n++;
          a.runs.inputTokens += num(d["input_tokens"]);
          a.runs.outputTokens += num(d["output_tokens"]);
          if (typeof d["cost_usd"] === "number") a.runs.usd += d["cost_usd"] as number;
          else a.runs.usdUnknownRuns++;
        }
        break;
      }
      case "model_call": {
        const task = d["task_id"];
        if (typeof task === "string") {
          const a = get(task);
          a.modelCalls.n++;
          a.modelCalls.promptTokens += num(d["prompt_tokens"]);
          a.modelCalls.completionTokens += num(d["completion_tokens"]);
          if (typeof d["cost_usd"] === "number") a.modelCalls.usd += d["cost_usd"] as number;
          else a.modelCalls.unpricedCalls++;
        }
        break;
      }
      case "research_call": {
        const task = d["task_id"];
        if (typeof task === "string") get(task).searches++;
        break;
      }
      case "zoo_observation": {
        observations++;
        const task = taskOfActor(String(d["agent"]));
        const path = d["path"];
        if (task && typeof path === "string") {
          const set = observed.get(task) ?? new Set<string>();
          if (d["action"] === "claim") set.add(path);
          else if (d["action"] === "release") set.delete(path);
          observed.set(task, set);
        }
        break;
      }
      case "zoo_gap":
        gaps++;
        break;
    }
  }

  for (const [actionId, st] of actionState) {
    const task = actionTask.get(actionId);
    if (!task) continue;
    const a = get(task);
    if (!TERMINAL_ACTION.has(st) && st !== "PREPARED") {
      a.currentAction = { actionId, state: st };
      if (["CLAIMED", "EXECUTING", "APPLIED", "RELEASE_PENDING", "RECOVERY_REQUIRED"].includes(st)) {
        a.heldFiles = [...new Set([...a.heldFiles, ...(actionFiles.get(actionId) ?? [])])].sort();
      }
    }
  }
  for (const [task, set] of observed) get(task).observedHeld = [...set].sort();
  for (const [task, st] of approval) {
    const a = get(task);
    if (st === "PENDING" && a.status === "planned") a.status = "waiting_approval";
  }
  for (const a of agents.values()) {
    a.runs.usd = Math.round(a.runs.usd * 1e6) / 1e6;
    a.modelCalls.usd = Math.round(a.modelCalls.usd * 1e6) / 1e6;
  }
  const list = [...agents.values()].filter((a) => a.taskId !== "validate" || a.steps > 0 || a.status !== "planned").sort((x, y) => (x.taskId < y.taskId ? -1 : x.taskId > y.taskId ? 1 : 0));
  return {
    atSeq: Number.isFinite(atSeq) ? atSeq : (events.at(-1)?.seq ?? 0),
    mission: { state: missionState, planRevision },
    agents: list,
    pendingApprovals: [...approval].filter(([, s]) => s === "PENDING").map(([t]) => t).sort(),
    alerts,
    zoo: { observations, gaps },
    delegations: del,
  };
}
