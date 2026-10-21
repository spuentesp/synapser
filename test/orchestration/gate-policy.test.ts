import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { CHALLENGE_TTL_MS, currentChallenge, decideApproval, readChallenge, requestApproval, verifyChallenge } from "../../src/orchestration/gates.ts";

// Gate policy: a one-time code lives 15 minutes and is spent by one decision; the requester never approves its own gate.
const R = "run-gate-policy";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("gate policy: one-time codes and requester separation", () => {
  let dir: string;
  let journal: Journal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-policy-"));
    journal = Journal.open(dir, R);
  });
  afterEach(() => {
    mock.restoreAll();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a code is good for 15 minutes from minting, and expires after that", () => {
    requestApproval(journal, R, "task-ttl", DIGEST, "why", "agent-a");
    const code = readChallenge(journal, "task-ttl", DIGEST)!;
    const minted = journal.listEvents().filter((e) => e.entity === "approval_challenge").at(-1)!.ts;
    assert.equal(verifyChallenge(journal, "task-ttl", DIGEST, code, minted + CHALLENGE_TTL_MS), "OK");
    assert.equal(verifyChallenge(journal, "task-ttl", DIGEST, code, minted + CHALLENGE_TTL_MS + 1), "CHALLENGE_EXPIRED");
  });

  test("a code is spent by the decision it authorises: a second use is refused", () => {
    requestApproval(journal, R, "task-once", DIGEST, "why", "agent-a");
    const code = readChallenge(journal, "task-once", DIGEST)!;
    const base = { taskId: "task-once", planDigest: DIGEST, currentDigest: DIGEST, decision: "APPROVED" as const, actor: "agent-b", channel: "mcp" as const };
    assert.deepEqual(decideApproval(journal, R, { ...base, challenge: code }), { ok: true });
    assert.equal(verifyChallenge(journal, "task-once", DIGEST, code), "CHALLENGE_USED");
    assert.equal(currentChallenge(journal, R, "task-once", DIGEST), null, "a decided gate shows no code");
  });

  test("while a gate is pending, an expired code is replaced by a fresh one for the operator", () => {
    const now = Date.now();
    mock.method(Date, "now", () => now);
    requestApproval(journal, R, "task-fresh", DIGEST, "why", "agent-a");
    const old = readChallenge(journal, "task-fresh", DIGEST)!;
    mock.method(Date, "now", () => now + CHALLENGE_TTL_MS + 1000);
    const fresh = currentChallenge(journal, R, "task-fresh", DIGEST)!;
    assert.notEqual(fresh, old);
    assert.equal(verifyChallenge(journal, "task-fresh", DIGEST, fresh), "OK");
    assert.equal(verifyChallenge(journal, "task-fresh", DIGEST, old), "BAD_CHALLENGE", "the expired code is superseded");
  });

  test("the requester of a gate cannot approve it, even by a human-looking channel", () => {
    requestApproval(journal, R, "task-self", DIGEST, "why", "agent-a");
    const base = { taskId: "task-self", planDigest: DIGEST, currentDigest: DIGEST, decision: "APPROVED" as const, channel: "ui" as const };
    assert.deepEqual(decideApproval(journal, R, { ...base, actor: "agent-a" }), { ok: false, code: "SELF_APPROVAL" });
    assert.deepEqual(decideApproval(journal, R, { ...base, actor: "ana" }), { ok: true });
  });
});
