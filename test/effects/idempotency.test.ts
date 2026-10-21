import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EffectBroker } from "../../src/effects/broker.ts";
import { BUILTIN_KINDS } from "../../src/effects/kinds.ts";
import type { Policy } from "../../src/effects/policy.ts";
import { Journal } from "../../src/journal/journal.ts";
import { decideApproval } from "../../src/orchestration/gates.ts";

// Effect idempotency: a repeated request is the same effect; a retry never runs an effect twice.
const R = "run-idempotency";
const ASK: Policy = { version: 1, default: "deny", rules: [{ id: "ask-hook", kind: "http.request", decision: "ask" }] };
const HOOK = { method: "POST", url: "https://hooks.example.com/deploy", body: "same" };

describe("effect idempotency", () => {
  let dir: string;
  let journal: Journal;
  let calls: number;
  let policy: Policy;
  let broker: EffectBroker;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "idem-"));
    journal = Journal.open(join(dir, "state"), R);
    calls = 0;
    policy = ASK;
    broker = new EffectBroker({
      journal, runId: R, repoRoot: dir, policy: () => policy, kinds: BUILTIN_KINDS,
      fetch: (async () => {
        calls++;
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
  });
  afterEach(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ask = (params: Record<string, unknown> = HOOK, by = "worker-1") => broker.request({ kind: "http.request", params, requestedBy: by, taskId: "t1" });

  test("the same request while it is pending is the same effect, not a second one", async () => {
    const first = await ask();
    const again = await ask();
    assert.ok(first.ok && again.ok);
    assert.equal(again.id, first.id);
    assert.equal(broker.records().length, 1);
  });

  test("once approved and done, a repeat returns the completed effect and runs nothing again", async () => {
    const first = await ask();
    const id = first.ok ? first.id : "";
    decideApproval(journal, R, { taskId: `effect:${id}`, planDigest: broker.status(id)!.digest, currentDigest: broker.status(id)!.digest, decision: "APPROVED", actor: "ana", channel: "cli" });
    await broker.tick();
    assert.equal(broker.status(id)!.state, "DONE");
    const repeat = await ask();
    assert.equal(repeat.ok && repeat.id, id);
    assert.equal(repeat.ok && repeat.state, "DONE");
    assert.equal(calls, 1, "the external call ran exactly once");
  });

  test("different parameters, a different requester or a different task are different effects", async () => {
    const a = await ask();
    const b = await ask({ ...HOOK, body: "other" });
    const c = await ask(HOOK, "worker-2");
    assert.ok(a.ok && b.ok && c.ok);
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  });

  test("a denied effect may be requested again: only failed, denied, stale or expired ones are retried", async () => {
    policy = { version: 1, default: "deny", rules: [] };
    const denied = await ask();
    assert.ok(denied.ok && denied.state === "DENIED");
    policy = ASK;
    const retried = await ask();
    assert.ok(retried.ok);
    assert.notEqual(retried.id, denied.id);
    assert.equal(retried.ok && retried.state, "PENDING");
  });
});
