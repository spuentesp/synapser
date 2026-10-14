// Z2: the collector never loses an audit event silently. Tested on a ring with the SAME semantics as
// the pinned binary (newest-N, since inclusive, oldest evicted, no sequence numbers) and on the
// real binary.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type AuditSource, fingerprint, ZooCollector, type ZooObservation } from "../../src/zoo/collector.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

class FakeRing implements AuditSource {
  events: ZooObservation[] = [];
  calls = 0;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  push(ts: number, agent = `${RUN}:t1`, action = "claim", path: string | null = "a.py", purpose: string | null = null): void {
    this.events.push({ ts, agent, action, path, purpose });
    while (this.events.length > this.cap) this.events.shift();
  }
  async auditLog(limit: number, sinceUnix?: number): Promise<unknown[]> {
    this.calls++;
    const kept = this.events.filter((e) => sinceUnix === undefined || e.ts >= sinceUnix);
    return kept.slice(Math.max(0, kept.length - limit));
  }
}

describe("ZooCollector against a ring with the binary's semantics", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());
  const obs = () => env.journal.listEvents().filter((e) => e.entity === "zoo_observation");
  const gaps = () => env.journal.listEvents().filter((e) => e.entity === "zoo_gap");
  const mk = (ring: FakeRing) => new ZooCollector({ source: ring, journal: env.journal, runId: RUN, cap: ring.cap });

  test("drain is idempotent and records only what is new", async () => {
    const ring = new FakeRing(10);
    [1, 2, 3].forEach((t) => ring.push(t));
    const c = mk(ring);
    assert.deepEqual(await c.drain(), { recorded: 3, gap: false, reset: false, ringLength: 3 });
    assert.equal((await c.drain()).recorded, 0, "nothing new");
    ring.push(4);
    ring.push(5);
    assert.equal((await c.drain()).recorded, 2);
    assert.deepEqual(obs().map((e) => (e.data as { ts: number }).ts), [1, 2, 3, 4, 5]);
    assert.equal(gaps().length, 0);
  });

  test("a boundary timestamp shared by identical events is counted exactly once each (multiset, not set)", async () => {
    const ring = new FakeRing(10);
    ring.push(1);
    ring.push(2, "x", "release", "f.py"); // first of two IDENTICAL events at ts 2
    const c = mk(ring);
    await c.drain();
    ring.push(2, "x", "release", "f.py"); // its twin appears after the first drain (same ts, same fingerprint)
    ring.push(3);
    const r = await c.drain();
    assert.equal(r.recorded, 2, "the twin and the new event; not the one already recorded");
    assert.equal(obs().filter((e) => (e.data as { ts: number }).ts === 2).length, 2);
    assert.equal((await c.drain()).recorded, 0);
  });

  test("Z2: when the ring wraps past the boundary a GAP is declared; the retained events are still recorded", async () => {
    const ring = new FakeRing(5);
    [1, 2, 3].forEach((t) => ring.push(t));
    const c = mk(ring);
    await c.drain();
    for (let t = 4; t <= 11; t++) ring.push(t); // 8 new events; only 5 fit: 4,5,6 were evicted unseen
    const r = await c.drain();
    assert.equal(r.gap, true);
    assert.equal(r.recorded, 5);
    assert.deepEqual(obs().map((e) => (e.data as { ts: number }).ts), [1, 2, 3, 7, 8, 9, 10, 11]);
    const g = gaps();
    assert.equal(g.length, 1);
    assert.equal(g[0]!.toState, "GAP");
    assert.equal((g[0]!.data as { since_ts: number }).since_ts, 3);
    assert.equal((g[0]!.data as { oldest_ts: number }).oldest_ts, 7);
  });

  test("no false alarm: a full ring that still contains the boundary is not a gap", async () => {
    const ring = new FakeRing(5);
    [1, 2, 3, 4, 5].forEach((t) => ring.push(t));
    const c = mk(ring);
    await c.drain();
    ring.push(6);
    ring.push(7); // evicts 1 and 2, both already recorded; boundary 5 is retained
    const r = await c.drain();
    assert.equal(r.gap, false);
    assert.equal(r.recorded, 2);
    assert.equal(gaps().length, 0);
  });

  test("a ring OLDER than our boundary (state replaced) is declared RESET and re-baselined, not trusted silently", async () => {
    const ring = new FakeRing(10);
    [100, 101].forEach((t) => ring.push(t));
    const c = mk(ring);
    await c.drain();
    ring.events = [];
    [1, 2].forEach((t) => ring.push(t));
    const r = await c.drain();
    assert.equal(r.reset, true);
    assert.equal(gaps()[0]!.toState, "RESET");
    assert.equal(r.recorded, 2);
  });

  test("a restarted collector resumes from the LEDGER: no duplicates, no re-reading from scratch", async () => {
    const ring = new FakeRing(10);
    [1, 2, 3].forEach((t) => ring.push(t));
    await mk(ring).drain();
    ring.push(4);
    const again = mk(ring); // a new instance, same journal
    assert.equal(again.boundary, 3);
    assert.equal((await again.drain()).recorded, 1);
    assert.equal(obs().length, 4);
  });

  test("observations are tagged ours/not-ours and the fingerprint is a pure function of the event", async () => {
    const ring = new FakeRing(10);
    ring.push(1, `${RUN}:t1`, "claim", "a.py");
    ring.push(2, "someone-else", "claim", "b.py");
    await mk(ring).drain();
    assert.deepEqual(obs().map((e) => (e.data as { ours: boolean }).ours), [true, false]);
    const o = { ts: 1, agent: "a", action: "claim", path: "p", purpose: null };
    assert.equal(fingerprint(o), fingerprint({ ...o }));
    assert.notEqual(fingerprint(o), fingerprint({ ...o, path: "q" }));
  });

  test("the collector only ever READS: its source exposes nothing but auditLog", async () => {
    const ring = new FakeRing(10);
    ring.push(1);
    const readOnly: AuditSource = { auditLog: (l, s) => ring.auditLog(l, s) };
    const c = new ZooCollector({ source: readOnly, journal: env.journal, runId: RUN });
    assert.equal((await c.drain()).recorded, 1);
  });
});

describe("ZooCollector against the real binary", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  test("claims by two actors are observed once each, survive a re-drain, and the real ring semantics hold", async () => {
    const c = new ZooCollector({ source: env.zoo, journal: env.journal, runId: RUN });
    await env.zoo.claim(`${RUN}:ta`, ["app/schema.py" as never], "edit", { purpose: "A edits" });
    await env.zoo.claim(`${RUN}:tb`, ["app/schema.py" as never], "edit", { purpose: "B edits" }); // conflict: not a claim event
    await env.zoo.release(`${RUN}:ta`, ["app/schema.py" as never]);
    const r1 = await c.drain();
    assert.ok(r1.recorded >= 2);
    assert.equal(r1.gap, false);
    const seen = env.journal.listEvents().filter((e) => e.entity === "zoo_observation");
    const actions = seen.map((e) => `${(e.data as { agent: string }).agent.split(":")[1]}:${(e.data as { action: string }).action}`);
    assert.ok(actions.includes("ta:claim") && actions.includes("ta:release"), actions.join(","));
    assert.equal(seen.every((e) => (e.data as { ours: boolean }).ours), true);
    assert.equal((await c.drain()).recorded, 0, "idempotent against the real ring");

    // activity recorded after the first drain is picked up, once
    await env.zoo.claim(`${RUN}:tb`, ["app/client.py" as never], "edit", { purpose: "B now" });
    assert.equal((await c.drain()).recorded, 1);
    assert.equal((await c.drain()).recorded, 0);
  });
});
