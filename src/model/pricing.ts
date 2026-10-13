// USD per million tokens, from `GET /v1/models?verbose=true` on the hackathon account
// (13 oct 2026, evidence/models.json). The non-verbose listing has no `pricing` field, which is
// why an earlier version of this table wrongly had zeros. It is an ESTIMATE: billing is the source.

export interface ModelPrice {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

const TABLE: Readonly<Record<string, ModelPrice>> = {
  "nvidia/Nemotron-3_5-Lightning": { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 },
  "nvidia/nemotron-3-super-120b-a12b": { inputPerMillionUsd: 0.3, outputPerMillionUsd: 0.9 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { inputPerMillionUsd: 1.0, outputPerMillionUsd: 3.0 },
};

/** `null` when the model is not in the table: unknown cost is reported as unknown, never as zero. */
export function priceFor(modelId: string): ModelPrice | null {
  return TABLE[modelId] ?? null;
}

/** Reasoning tokens are already inside `completionTokens` (they are billed as output). */
export function estimateCostUsd(modelId: string, usage: { promptTokens: number; completionTokens: number }): number | null {
  const p = priceFor(modelId);
  if (!p) return null;
  return (usage.promptTokens * p.inputPerMillionUsd + usage.completionTokens * p.outputPerMillionUsd) / 1_000_000;
}
