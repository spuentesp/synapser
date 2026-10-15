// S13 (design §6, §17): a wedged coordinator call past the timeout must not allow another
// mutating call until the child's exit is confirmed and state is reconciled.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ZooAdapter } from "../../src/zoo/adapter.ts";
import { ZooTransport } from "../../src/zoo/transport.ts";
import { ZooError } from "../../src/zoo/types.ts";
import { wp } from "../helpers.ts";

const FAKE = new URL("../fixtures/fake-zoo.mjs", import.meta.url).pathname;

test("S13: timeout → child killed and confirmed → quarantined → reconcile restores", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "fake-zoo-")), "hang-once");
  const t = new ZooTransport({
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_ZOO_MARKER: marker },
    // A hang is detected at this budget. The fresh child's handshake has its own budget (handshakeTimeoutMs), so a cold start
    // under load is not taken for a hang. The intermittent failure is not reproduced; this is the limit that was shared before.
    callTimeoutMs: 1_000,
    killGraceMs: 2000,
  });
  const zoo = new ZooAdapter(t);
  await zoo.start();
  const gen1 = t.generation;

  // 1) the claim hangs: TIMEOUT, effect unknown
  await assert.rejects(zoo.claim("a", wp("x.py"), "edit"), (e) => e instanceof ZooError && e.kind === "TIMEOUT");
  assert.ok(existsSync(marker), "fake server did see the call");
  assert.equal(zoo.transportState, "quarantined");

  // 2) no mutating call is admitted, and nothing reaches a (dead) process
  await assert.rejects(zoo.claim("b", wp("y.py"), "edit"), (e) => e instanceof ZooError && e.kind === "QUARANTINED");
  await assert.rejects(zoo.release("b", wp("y.py")), (e) => e instanceof ZooError && e.kind === "QUARANTINED");

  // 3) explicit reconcile: fresh process, registry observed, then calls flow again
  const rec = await zoo.reconcile();
  assert.ok(t.generation > gen1);
  assert.deepEqual(rec.claims, []);
  assert.equal(zoo.transportState, "ready");
  assert.equal((await zoo.claim("a", wp("x.py"), "edit")).kind, "granted");
  await zoo.close();
});

test("a child that dies on its own also quarantines instead of degrading to advisory", async () => {
  const t = new ZooTransport({ command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ZOO_MARKER: "/nonexistent/x" } });
  const zoo = new ZooAdapter(t);
  await zoo.start();
  // marker path unwritable → fake server throws on first claim and exits
  await assert.rejects(zoo.claim("a", wp("x.py"), "edit"), (e) => e instanceof ZooError);
  assert.notEqual(zoo.transportState, "ready");
  await assert.rejects(zoo.claim("a", wp("x.py"), "edit"), (e) => e instanceof ZooError);
  await zoo.close();
});
