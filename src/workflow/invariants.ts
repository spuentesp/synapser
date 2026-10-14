// Workflow invariants C1, C3, C4 as ledger checkers (plan 13 §4.4). C2 (a change to the conditions
// invalidates DONE) is enforced by the manager and proven in its tests.

import type { Violation } from "../audit/invariants.ts";
import type { Journal } from "../journal/journal.ts";
import type { Workflow } from "./model.ts";

interface Row {
  seq: number;
  id: string;
  status: string;
  evidence: string;
  required: boolean;
  snapshot: string;
  round: number;
}

const rows = (journal: Journal): Row[] =>
  journal
    .listEvents()
    .filter((e) => e.entity === "condition")
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      return { seq: e.seq, id: e.entityId, status: String(e.toState), evidence: String(d["evidence"]), required: d["required"] === true, snapshot: String(d["snapshot"]), round: Number(d["round"]) };
    });

/** C1 (+ E3): DONE only when every required condition of the LAST round is satisfied or waived, and a
 *  required condition was not satisfied by secondary evidence alone unless that was explicitly accepted. */
export function checkWorkflowDone(journal: Journal, w: Workflow): Violation[] {
  const done = journal.listEvents().filter((e) => e.entity === "workflow" && e.toState === "DONE").at(-1);
  if (!done) return [];
  const all = rows(journal).filter((r) => r.seq < done.seq);
  const last = Math.max(0, ...all.map((r) => r.round));
  const lastRound = all.filter((r) => r.round === last);
  const out: Violation[] = [];
  if (lastRound.length === 0) return [{ invariant: "C1", code: "DONE_WITHOUT_EVALUATION", where: w.id, detail: {} }];
  for (const c of w.conditions) {
    if (!c.required || c.waivedBy) continue;
    const r = lastRound.find((x) => x.id === c.id);
    if (!r) out.push({ invariant: "C1", code: "CONDITION_NOT_EVALUATED", where: c.id, detail: { round: last } });
    else if (r.status !== "SATISFIED" && r.status !== "WAIVED") out.push({ invariant: "C1", code: "REQUIRED_CONDITION_UNMET", where: c.id, detail: { status: r.status, round: last } });
    else if (r.evidence === "secondary" && !c.secondaryAccepted) out.push({ invariant: "C1", code: "SECONDARY_EVIDENCE_ONLY", where: c.id, detail: { round: last } });
  }
  lastRound.filter((r) => r.id.startsWith("guard:") && r.status !== "SATISFIED").forEach((r) => out.push({ invariant: "C1", code: "NON_GOAL_VIOLATED", where: r.id, detail: { round: last } }));
  return out;
}

/** C4: within one round every result was judged on the same snapshot as the round itself. */
export function checkSameSnapshot(journal: Journal): Violation[] {
  const rounds = new Map<number, string>();
  for (const e of journal.listEvents()) {
    if (e.entity === "condition_round") rounds.set(Number(e.entityId), String((e.data as { snapshot?: string }).snapshot));
  }
  const out: Violation[] = [];
  for (const r of rows(journal)) {
    const s = rounds.get(r.round);
    if (s !== undefined && s !== r.snapshot) out.push({ invariant: "C4", code: "MIXED_SNAPSHOTS", where: r.id, detail: { round: r.round } });
  }
  return out;
}

/** C3: every WAIVED result is backed by a waiver (actor + reason) in the workflow document. */
export function checkWaivers(journal: Journal, w: Workflow): Violation[] {
  const out: Violation[] = [];
  for (const r of rows(journal).filter((x) => x.status === "WAIVED")) {
    const c = w.conditions.find((x) => x.id === r.id);
    if (!c?.waivedBy?.actor || !c.waivedBy.reason) out.push({ invariant: "C3", code: "WAIVER_WITHOUT_ACTOR", where: r.id, detail: {} });
  }
  return out;
}
