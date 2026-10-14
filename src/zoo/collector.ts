// Observation of Zoanthrope's audit ring (plan 11 §3). READ-ONLY: it never writes to Zoanthrope.
//
// Facts established by spike S-Z against the pinned binary (docs/plans/11 §2):
//   · events carry no sequence number, only ts (float seconds, µs resolution, monotone), agent,
//     action, path, purpose and stamp NAMES;
//   · the ring holds the newest 1000 events and silently drops the oldest;
//   · `since_unix` keeps events with ts >= since (inclusive), so a boundary is re-read;
//   · the ring survives a restart.
// Consequences: dedupe at the boundary by a multiset of fingerprints, and declare a GAP — never hide
// one — whenever the ring is full and its oldest event is newer than our boundary.

import { createHash } from "node:crypto";
import type { Journal } from "../journal/journal.ts";

export const RING_CAP = 1000;

export interface ZooObservation {
  ts: number;
  agent: string;
  action: string;
  path: string | null;
  purpose: string | null;
  stamps?: string[];
}

export interface AuditSource {
  auditLog(limit: number, sinceUnix?: number): Promise<unknown[]>;
}

export interface DrainResult {
  recorded: number;
  gap: boolean;
  reset: boolean;
  ringLength: number;
}

export const fingerprint = (o: ZooObservation): string =>
  createHash("sha256")
    .update(JSON.stringify([o.ts, o.agent, o.action, o.path, o.purpose, o.stamps ?? null]))
    .digest("hex")
    .slice(0, 16);

const asObs = (e: unknown): ZooObservation | null => {
  const o = e as Record<string, unknown> | null;
  if (!o || typeof o["ts"] !== "number" || typeof o["agent"] !== "string" || typeof o["action"] !== "string") return null;
  return {
    ts: o["ts"],
    agent: o["agent"],
    action: o["action"],
    path: typeof o["path"] === "string" ? o["path"] : null,
    purpose: typeof o["purpose"] === "string" ? o["purpose"] : null,
    ...(Array.isArray(o["stamps"]) ? { stamps: (o["stamps"] as unknown[]).map(String) } : {}),
  };
};

export class ZooCollector {
  readonly #src: AuditSource;
  readonly #journal: Journal;
  readonly #runId: string;
  readonly #cap: number;
  #lastTs: number | null = null;
  /** Fingerprint multiset of the events AT `#lastTs` that are already on the ledger. */
  #seen = new Map<string, number>();

  constructor(o: { source: AuditSource; journal: Journal; runId: string; cap?: number }) {
    this.#src = o.source;
    this.#journal = o.journal;
    this.#runId = o.runId;
    this.#cap = o.cap ?? RING_CAP;
    this.#restore();
  }

  /** The ledger is the memory: a restarted collector resumes exactly where the ledger says. */
  #restore(): void {
    let last: number | null = null;
    for (const e of this.#journal.listEvents()) {
      if (e.entity !== "zoo_observation") continue;
      const ts = (e.data as { ts?: number }).ts;
      if (typeof ts === "number" && (last === null || ts > last)) last = ts;
    }
    this.#lastTs = last;
    this.#seen = new Map();
    if (last === null) return;
    for (const e of this.#journal.listEvents()) {
      if (e.entity !== "zoo_observation") continue;
      const d = e.data as { ts?: number; fp?: string };
      if (d.ts === last && d.fp) this.#seen.set(d.fp, (this.#seen.get(d.fp) ?? 0) + 1);
    }
  }

  get boundary(): number | null {
    return this.#lastTs;
  }

  async drain(): Promise<DrainResult> {
    const raw = await this.#src.auditLog(this.#cap);
    const ring = raw.map(asObs).filter((x): x is ZooObservation => x !== null);
    const full = ring.length >= this.#cap;
    const oldest = ring[0]?.ts ?? null;
    const newest = ring.at(-1)?.ts ?? null;

    let gap = false;
    let reset = false;
    if (this.#lastTs !== null && ring.length > 0) {
      if ((newest as number) < this.#lastTs) {
        // the ring is older than our boundary: Zoanthrope's state was replaced or cleared
        reset = true;
        this.#lastTs = null;
        this.#seen = new Map();
      } else if (full && (oldest as number) > this.#lastTs) {
        gap = true;
      }
    }

    const fresh: { o: ZooObservation; fp: string }[] = [];
    const used = new Map<string, number>();
    for (const o of ring) {
      const fp = fingerprint(o);
      if (this.#lastTs !== null && o.ts < this.#lastTs) continue;
      if (this.#lastTs !== null && o.ts === this.#lastTs) {
        const n = (used.get(fp) ?? 0) + 1;
        used.set(fp, n);
        if (n <= (this.#seen.get(fp) ?? 0)) continue; // already recorded
      }
      fresh.push({ o, fp });
    }

    if (gap || reset || fresh.length > 0) {
      this.#journal.tx((t) => {
        if (gap) {
          t.event(this.#runId, "zoo_gap", "ring", null, "GAP", {
            since_ts: this.#lastTs,
            oldest_ts: oldest,
            ring_length: ring.length,
            note: "the ring is full and its oldest event is newer than our boundary: events in between may have been evicted (at least one is unaccounted for)",
          });
        }
        if (reset) t.event(this.#runId, "zoo_gap", "ring", null, "RESET", { newest_ts: newest, note: "the ring is older than our boundary: Zoanthrope state was replaced" });
        fresh.forEach(({ o, fp }, i) => {
          t.event(this.#runId, "zoo_observation", `zoo-${o.ts.toFixed(6)}-${i}`, null, o.action, {
            ts: o.ts,
            agent: o.agent,
            action: o.action,
            path: o.path,
            purpose: o.purpose,
            ...(o.stamps ? { stamps: o.stamps } : {}),
            fp,
            ours: o.agent.startsWith(`${this.#runId}:`),
          });
        });
      });
    }
    if (fresh.length > 0) {
      const top = Math.max(...fresh.map((f) => f.o.ts));
      if (this.#lastTs === null || top > this.#lastTs) {
        this.#lastTs = top;
        this.#seen = new Map();
      }
      for (const f of fresh) if (f.o.ts === this.#lastTs) this.#seen.set(f.fp, (this.#seen.get(f.fp) ?? 0) + 1);
    }
    return { recorded: fresh.length, gap, reset, ringLength: ring.length };
  }
}
