// Tamper-evident event chain. Every event's hash covers the previous event's hash and the exact
// stored text of the event, so editing, deleting, reordering or inserting a past event changes every
// later hash. The database already refuses UPDATE/DELETE on events (triggers); the chain is what
// detects someone who bypassed the database engine (edited the file) — and it lets an export be
// verified OFFLINE, without trusting the process that produced it.
//
// The HEAD hash is a compact commitment to the whole history: anchor it somewhere the executor cannot
// write (a message, a ticket, a second system) and truncation of the tail becomes detectable too.

import { createHash } from "node:crypto";

export interface ChainFields {
  runId: string;
  seq: number;
  ts: number;
  entity: string;
  entityId: string;
  fromState: string | null;
  toState: string | null;
  /** The exact JSON text stored in the row. */
  dataJson: string;
}

export const genesisHash = (runId: string): string => `sha256:${createHash("sha256").update(`synapser-genesis:${runId}`).digest("hex")}`;

export function eventHash(prev: string, e: ChainFields): string {
  const body = [prev, e.runId, String(e.seq), String(e.ts), e.entity, e.entityId, e.fromState ?? "", e.toState ?? "", e.dataJson].join("\n");
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export interface ChainEvent extends ChainFields {
  prevHash: string;
  hash: string;
}

export interface ChainVerdict {
  ok: boolean;
  events: number;
  head: string;
  /** First sequence number at which the chain is broken, if any. */
  firstBadSeq: number | null;
  reason: string | null;
}

export function verifyChain(runId: string, events: readonly ChainEvent[], expectedHead?: string): ChainVerdict {
  let prev = genesisHash(runId);
  let expectSeq = 1;
  for (const e of events) {
    if (e.seq !== expectSeq) return bad(events, prev, e.seq, `sequence gap: expected ${expectSeq}, found ${e.seq}`);
    if (e.runId !== runId) return bad(events, prev, e.seq, `event belongs to run ${e.runId}`);
    if (e.prevHash !== prev) return bad(events, prev, e.seq, "prev_hash does not match the previous event");
    const h = eventHash(prev, e);
    if (h !== e.hash) return bad(events, prev, e.seq, "hash does not match the event content (edited)");
    prev = h;
    expectSeq++;
  }
  if (expectedHead !== undefined && expectedHead !== prev) {
    return { ok: false, events: events.length, head: prev, firstBadSeq: events.length + 1, reason: "head differs from the anchored head (tail truncated or extended)" };
  }
  return { ok: true, events: events.length, head: prev, firstBadSeq: null, reason: null };
}

const bad = (events: readonly ChainEvent[], head: string, seq: number, reason: string): ChainVerdict => ({
  ok: false,
  events: events.length,
  head,
  firstBadSeq: seq,
  reason,
});
