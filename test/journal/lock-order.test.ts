import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { acquireWorkspaceLock, acquireWorkspaceLockInOrder, LockBusy } from "../../src/journal/lock.ts";

// Plan 18 E10 (H10.2): the waiting order of the workspace lock. Waiters are served in arrival order, a waiter that gives up
// leaves no ticket, and a ticket of a process that is gone does not block the queue.
const ws = () => mkdtempSync(join(tmpdir(), "lock-order-ws-"));
const state = () => mkdtempSync(join(tmpdir(), "lock-order-state-"));
const tickets = (dir: string) => (existsSync(join(dir, "lock-queue")) ? readdirSync(join(dir, "lock-queue")) : []);

describe("H10.2 the workspace lock serves waiters first come, first served", () => {
  test("two waiters that arrive in order acquire in that order", async () => {
    const dir = state();
    const w = ws();
    const holder = acquireWorkspaceLock(dir, w);
    const served: string[] = [];
    const a = acquireWorkspaceLockInOrder(dir, w, { pollMs: 2 }).then((l) => (served.push("A"), l));
    await new Promise((r) => setTimeout(r, 20));
    const b = acquireWorkspaceLockInOrder(dir, w, { pollMs: 2 }).then((l) => (served.push("B"), l));
    await new Promise((r) => setTimeout(r, 20));
    holder.release();
    const first = await a;
    assert.deepEqual(served, ["A"], "the earlier waiter is served first, the later one still waits");
    first.release();
    const second = await b;
    assert.deepEqual(served, ["A", "B"]);
    second.release();
    assert.deepEqual(tickets(dir), [], "no ticket is left behind");
  });

  test("a waiter that times out leaves no ticket and does not hold the lock", async () => {
    const dir = state();
    const w = ws();
    const holder = acquireWorkspaceLock(dir, w);
    await assert.rejects(acquireWorkspaceLockInOrder(dir, w, { timeoutMs: 60, pollMs: 5 }), LockBusy);
    assert.deepEqual(tickets(dir), []);
    holder.release();
    acquireWorkspaceLock(dir, w).release();
  });

  test("a ticket of a process that is gone is pruned, so it does not block the queue", async () => {
    const dir = state();
    const w = ws();
    const holder = acquireWorkspaceLock(dir, w);
    const queue = join(dir, "lock-queue");
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, `000000000000000-00000001-999999`), "{}");
    const pending = acquireWorkspaceLockInOrder(dir, w, { pollMs: 2 });
    holder.release();
    const lock = await pending;
    lock.release();
    assert.deepEqual(tickets(dir), []);
  });
});
