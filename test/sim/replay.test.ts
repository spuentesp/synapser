import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Edit } from "../../src/digest/canonical.ts";
import { seededRandom, withEnvAsync } from "../../src/sim/env.ts";
import { makeEnv, propose, T1 } from "../executor/env.ts";

// Plan 18 E11 (H11.3, the whole run): one action run from start to SETTLED under a seeded clock, generator and identifiers.
// The same seed gives the same journal, event for event; another seed gives another one. The journal stores its events
// with a hash chain, so the comparison covers the chain too.
const BILLING: Edit = { op: "write_file", path: "app/billing.py", content: '"""billing v2"""\n' };

async function replay(seed: number): Promise<string> {
  const env = await makeEnv();
  try {
    const rng = seededRandom(seed);
    let tick = 0;
    const simulated = {
      now: () => 1_700_000_000_000 + tick++ * 1000,
      random: rng,
      uuid: () => Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16)).join(""),
    };
    return await withEnvAsync(simulated, async () => {
      const inc = env.exec.beginSession(T1).incarnation;
      const p = await propose(env, T1, inc, ["app/billing.py"], [BILLING]);
      const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc });
      assert.equal(r.status, "SETTLED");
      return JSON.stringify(env.journal.listEvents(0).map((e) => [e.seq, e.ts, e.entity, e.entityId, e.fromState, e.toState, e.data]));
    });
  } finally {
    await env.close();
  }
}

describe("H11.3 a whole run replays from its seed", () => {
  test("the same seed gives the same journal, event for event", async () => {
    const a = await replay(7);
    const b = await replay(7);
    assert.ok(a.length > 2, "the run recorded events");
    assert.equal(a, b);
  });

  test("another seed gives a different journal, so the replay is not a constant", async () => {
    assert.notEqual(await replay(7), await replay(8));
  });
});
