// Pools bound how many agents of a kind run at once (plan 13 §7, T3). A task that cannot get a slot
// WAITS for one — it does not fail and it does not skip the queue: FIFO per pool.

export interface PoolSpec {
  id: string;
  members: readonly string[];
  maxConcurrent: number;
}

export class PoolLimiter {
  readonly #byProfile = new Map<string, string>();
  readonly #cap = new Map<string, number>();
  readonly #inUse = new Map<string, number>();
  readonly #queue = new Map<string, (() => void)[]>();
  #peak = new Map<string, number>();

  constructor(pools: readonly PoolSpec[]) {
    for (const p of pools) {
      if (!(p.maxConcurrent >= 1)) throw new Error(`pool ${p.id}: maxConcurrent must be >= 1`);
      this.#cap.set(p.id, p.maxConcurrent);
      for (const m of p.members) this.#byProfile.set(m, p.id);
    }
  }

  poolOf(profileId: string): string | null {
    return this.#byProfile.get(profileId) ?? null;
  }
  inUse(poolId: string): number {
    return this.#inUse.get(poolId) ?? 0;
  }
  /** Highest concurrency observed (for tests and the UI). */
  peak(poolId: string): number {
    return this.#peak.get(poolId) ?? 0;
  }

  async run<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const pool = this.#byProfile.get(profileId);
    if (!pool) return fn();
    const cap = this.#cap.get(pool) as number;
    if ((this.#inUse.get(pool) ?? 0) >= cap) await new Promise<void>((r) => (this.#queue.get(pool) ?? this.#queue.set(pool, []).get(pool)!).push(r));
    else this.#take(pool);
    try {
      return await fn();
    } finally {
      const next = this.#queue.get(pool)?.shift();
      if (next) next(); // hand the slot straight to the next waiter: usage never dips below the queue
      else this.#inUse.set(pool, (this.#inUse.get(pool) ?? 1) - 1);
    }
  }

  #take(pool: string): void {
    const n = (this.#inUse.get(pool) ?? 0) + 1;
    this.#inUse.set(pool, n);
    this.#peak.set(pool, Math.max(this.#peak.get(pool) ?? 0, n));
  }
}
