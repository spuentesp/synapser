// Mission budget (design §8, plan 06 §7). Consulted BEFORE every call; nothing is admitted once
// it is exhausted. Reasoning tokens count: they are billed inside completion_tokens.

import { ModelError } from "./types.ts";

export interface BudgetLimits {
  maxTokens?: number;
  maxCalls?: number;
  /** Absolute epoch-ms deadline for the whole mission. */
  deadlineMs?: number;
}

export class BudgetManager {
  readonly limits: BudgetLimits;
  readonly #now: () => number;
  #tokens = 0;
  #calls = 0;

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.#now = now;
  }

  /** Throws BUDGET if the next call is not allowed; returns the max_tokens the call may use. */
  reserve(requestedMaxTokens: number): number {
    const l = this.limits;
    if (l.deadlineMs !== undefined && this.#now() >= l.deadlineMs) throw new ModelError("BUDGET", "mission time budget exhausted");
    if (l.maxCalls !== undefined && this.#calls >= l.maxCalls) throw new ModelError("BUDGET", "model call budget exhausted");
    if (l.maxTokens === undefined) return requestedMaxTokens;
    const remaining = l.maxTokens - this.#tokens;
    if (remaining <= 0) throw new ModelError("BUDGET", "token budget exhausted");
    return Math.min(requestedMaxTokens, remaining);
  }

  record(usage: { promptTokens: number; completionTokens: number }): void {
    this.#calls += 1;
    this.#tokens += usage.promptTokens + usage.completionTokens;
  }

  /** A call that failed after being sent still counts against the call budget. */
  recordFailedCall(): void {
    this.#calls += 1;
  }

  snapshot() {
    return { tokens: this.#tokens, calls: this.#calls, ...this.limits };
  }
}
