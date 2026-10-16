// The toolbox the orchestrator chooses from (plan 10 §2). A card is DERIVED: what a profile can do
// comes from its declaration, what it costs and how it performs comes from the ledger. Cost is
// known (a published tariff), estimated (learned, with a range) or unknown — never confused.

import type { Journal } from "../journal/journal.ts";
import { type AgentProfile, adapterOf, type Tier } from "../agents/profile.ts";
import { effectiveProfileCapabilities, type EffectiveProfileCapabilities } from "../agents/capabilities.ts";
import type { SkillSelection } from "../agents/adapter.ts";

export const STEP_KINDS = ["write", "advise", "research", "review"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type CostEstimate =
  | { basis: "known"; usdPerRun: number }
  | { basis: "estimated"; usdPerRun: number; low: number; high: number; n: number }
  | { basis: "unknown"; reason: "NO_HISTORY" | "TOO_FEW_RUNS" | "UNSTABLE" };

export interface ProfileCard {
  id: string;
  kinds: StepKind[];
  integration: "direct" | "pending";
  tier: Tier;
  pool: string | null;
  strengths: string[];
  /** Machine-matchable capabilities derived from the adapter and effective profile, never library text. */
  capabilities: EffectiveProfileCapabilities;
  /** Skill IDs authorized by the operator for this profile in this run's frozen library snapshot. */
  allowedSkillIds: string[];
  cost: CostEstimate;
  observed: { runs: number; succeeded: number; medianMs: number } | null;
  enabled: boolean;
  disabledReason?: string;
}

/** One finished run, as the estimator sees it. `usd` is null when the run reported no cost. */
export interface RunSample {
  profileId: string;
  succeeded: boolean;
  usd: number | null;
  durationMs: number;
  at: number;
}

export interface CatalogOptions {
  /** Published tariffs: USD per run for profiles whose price is contractual, not learned. */
  knownUsdPerRun?: Readonly<Record<string, number>>;
  /** Minimum costed runs before an estimate is offered. */
  nMin?: number;
  /** An estimate whose backtest median relative error exceeds this is degraded to unknown. */
  maxRelErr?: number;
  /** Extra kinds per profile (e.g. a profile wired to a research tool). */
  extraKinds?: Readonly<Record<string, readonly StepKind[]>>;
  allowedSkillsByProfile?: ReadonlyMap<string, readonly string[]>;
}

export const kindsOf = (p: AgentProfile): StepKind[] => (p.role === "writer" ? ["write"] : ["advise", "review"]);

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const quantile = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;

/**
 * Pure function of the chronological list of observed per-run costs. Same history ⇒ same estimate.
 * The backtest predicts each run from the median of the runs before it; a model that cannot
 * predict its own past is not allowed to predict the future.
 */
export function estimateCost(usdChrono: readonly number[], nMin = 3, maxRelErr = 1): CostEstimate {
  if (usdChrono.length === 0) return { basis: "unknown", reason: "NO_HISTORY" };
  if (usdChrono.length < nMin) return { basis: "unknown", reason: "TOO_FEW_RUNS" };
  if (usdChrono.length >= nMin + 3) {
    const errs: number[] = [];
    for (let i = nMin; i < usdChrono.length; i++) {
      const actual = usdChrono[i] as number;
      const pred = median(usdChrono.slice(0, i));
      errs.push(Math.abs(pred - actual) / Math.max(actual, 1e-9));
    }
    if (median(errs) > maxRelErr) return { basis: "unknown", reason: "UNSTABLE" };
  }
  const sorted = [...usdChrono].sort((a, b) => a - b);
  return { basis: "estimated", usdPerRun: median(usdChrono), low: quantile(sorted, 0.1), high: quantile(sorted, 0.9), n: usdChrono.length };
}

export function buildCatalog(profiles: readonly AgentProfile[], samples: readonly RunSample[], o: CatalogOptions = {}): ProfileCard[] {
  return profiles.map((p) => {
    const mine = samples.filter((s) => s.profileId === p.id).sort((a, b) => a.at - b.at);
    const costed = mine.filter((s) => s.usd !== null).map((s) => s.usd as number);
    const tariff = o.knownUsdPerRun?.[p.id];
    const cost: CostEstimate = tariff !== undefined ? { basis: "known", usdPerRun: tariff } : estimateCost(costed, o.nMin ?? 3, o.maxRelErr ?? 1);
    const kinds = [...new Set([...kindsOf(p), ...(o.extraKinds?.[p.id] ?? [])])].sort() as StepKind[];
    const capabilities = effectiveProfileCapabilities(p);
    return {
      id: p.id,
      kinds,
      integration: adapterOf(p) === "native" ? "direct" : "pending",
      tier: p.tier ?? "standard",
      pool: p.pool ?? null,
      strengths: [...p.tags],
      capabilities,
      allowedSkillIds: [...(o.allowedSkillsByProfile?.get(p.id) ?? [])],
      cost,
      observed: mine.length === 0 ? null : { runs: mine.length, succeeded: mine.filter((s) => s.succeeded).length, medianMs: median(mine.map((s) => s.durationMs)) },
      enabled: p.enabled && capabilities.available,
      ...(!capabilities.available ? { disabledReason: `adapter ${adapterOf(p)} has no runner implementation` } : p.disabledReason ? { disabledReason: p.disabledReason } : {}),
    };
  });
}

/** Samples from the ledger. Cost counts only when the run reported or logged it (never `unknown`). */
export function samplesFromJournal(journal: Journal): RunSample[] {
  return journal.listAgentRuns().map((r) => ({
    profileId: r.profileId,
    succeeded: r.outcome === "SUCCEEDED",
    usd: r.costUsd !== null && r.usageProvenance !== "unknown" ? r.costUsd : null,
    durationMs: Math.max(0, (r.finishedAt ?? r.startedAt) - r.startedAt),
    at: r.startedAt,
  }));
}
