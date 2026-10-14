// The router decides; the model only suggests (plan 10 D1). A pure function: the same task,
// catalog and options always yield the same assignment, so every dispatch can be re-derived.

import type { ProfileCard, StepKind } from "./catalog.ts";

export interface RouteRequest {
  kind: StepKind;
  /** The model's suggestion: a tie-breaker, never an override. */
  suggested?: string | undefined;
  /** Capability tags the task asks for (matched against card strengths). */
  tags?: readonly string[];
  /** Profiles that must not be used for this task (e.g. already failed on it). */
  exclude?: readonly string[];
}

export interface Alert {
  code: "COST_UNKNOWN" | "SUGGESTION_OVERRIDDEN";
  profileId: string;
  detail?: string;
}

export type RouteDecision =
  | { ok: true; profileId: string; reason: "policy" | "suggestion"; alerts: Alert[]; considered: { profileId: string; rank: number }[] }
  | { ok: false; code: "NO_CANDIDATE"; rejected: { profileId: string; code: "DISABLED" | "KIND_MISMATCH" | "EXCLUDED" }[] };

const basisRank = (c: ProfileCard["cost"]): number => (c.basis === "known" ? 0 : c.basis === "estimated" ? 1 : 2);
const usd = (c: ProfileCard["cost"]): number => (c.basis === "unknown" ? Number.POSITIVE_INFINITY : c.usdPerRun);
const successRate = (c: ProfileCard): number => (c.observed && c.observed.runs > 0 ? c.observed.succeeded / c.observed.runs : 0.5);

export function route(req: RouteRequest, catalog: readonly ProfileCard[]): RouteDecision {
  const rejected: { profileId: string; code: "DISABLED" | "KIND_MISMATCH" | "EXCLUDED" }[] = [];
  const candidates: ProfileCard[] = [];
  for (const c of catalog) {
    if (req.exclude?.includes(c.id)) rejected.push({ profileId: c.id, code: "EXCLUDED" });
    else if (!c.enabled) rejected.push({ profileId: c.id, code: "DISABLED" });
    else if (!c.kinds.includes(req.kind)) rejected.push({ profileId: c.id, code: "KIND_MISMATCH" });
    else candidates.push(c);
  }
  // a total order, so the answer does not depend on the order the catalog happened to be listed in
  rejected.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
  if (candidates.length === 0) return { ok: false, code: "NO_CANDIDATE", rejected };

  const want = new Set(req.tags ?? []);
  const fit = (c: ProfileCard) => c.strengths.filter((s) => want.has(s)).length;
  // a profile built for repair rounds does not win ordinary work just by sorting first
  const misfit = (c: ProfileCard): number => (c.strengths.includes("repair") && !want.has("repair") ? 1 : 0);
  // lexicographic: capability fit, then not-a-misfit, then how well the cost is known, then cost, then
  // track record, then the model's suggestion, then id (total order ⇒ deterministic)
  const key = (c: ProfileCard): (number | string)[] => [-fit(c), misfit(c), basisRank(c.cost), usd(c.cost), -successRate(c), c.id === req.suggested ? 0 : 1, c.id];
  const cmp = (a: ProfileCard, b: ProfileCard): number => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const x = ka[i] as number | string;
      const y = kb[i] as number | string;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const ranked = [...candidates].sort(cmp);
  const chosen = ranked[0] as ProfileCard;
  const alerts: Alert[] = [];
  if (chosen.cost.basis === "unknown") alerts.push({ code: "COST_UNKNOWN", profileId: chosen.id, detail: chosen.cost.reason });
  if (req.suggested && req.suggested !== chosen.id) {
    alerts.push({ code: "SUGGESTION_OVERRIDDEN", profileId: req.suggested, detail: `routed to ${chosen.id}` });
  }
  return {
    ok: true,
    profileId: chosen.id,
    reason: req.suggested === chosen.id ? "suggestion" : "policy",
    alerts,
    considered: ranked.map((c, i) => ({ profileId: c.id, rank: i })),
  };
}

/** Upper bound of a plan's cost: known + estimated(high); unknown tasks are listed, not guessed. */
export function planCost(
  tasks: readonly { id: string; kind: StepKind; profile?: string | undefined; tags?: readonly string[] }[],
  catalog: readonly ProfileCard[],
): { knownUsd: number; estimatedHighUsd: number; unknownTasks: string[]; unroutable: string[] } {
  let knownUsd = 0;
  let estimatedHighUsd = 0;
  const unknownTasks: string[] = [];
  const unroutable: string[] = [];
  for (const t of tasks) {
    const d = route({ kind: t.kind, suggested: t.profile, ...(t.tags ? { tags: t.tags } : {}) }, catalog);
    if (!d.ok) {
      unroutable.push(t.id);
      continue;
    }
    const c = catalog.find((x) => x.id === d.profileId) as ProfileCard;
    if (c.cost.basis === "known") knownUsd += c.cost.usdPerRun;
    else if (c.cost.basis === "estimated") estimatedHighUsd += c.cost.high;
    else unknownTasks.push(t.id);
  }
  return { knownUsd, estimatedHighUsd, unknownTasks, unroutable };
}
