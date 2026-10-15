// Plan 18 E11 (H11.1, H11.3): the only source of time, randomness and identifiers for the recovery core. By default it is
// the real system. A test installs a simulated environment: a clock that moves when the test says so, and a seeded
// generator, so that a run can be replayed exactly from its seed.
import { randomUUID } from "node:crypto";

export interface SimEnv {
  now(): number;
  random(): number;
  uuid(): string;
}

let current: SimEnv = { now: () => Date.now(), random: () => Math.random(), uuid: () => randomUUID() };

export const env: SimEnv = {
  now: () => current.now(),
  random: () => current.random(),
  uuid: () => current.uuid(),
};

/** Installs a simulated environment for the duration of `fn`, then restores the previous one. */
export function withEnv<T>(overrides: Partial<SimEnv>, fn: () => T): T {
  const previous = current;
  current = { ...current, ...overrides };
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** A seeded generator (mulberry32). Same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
