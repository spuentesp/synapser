// Day 18: happy path + S01–S04, S07, S09, S10, S15, S16 and INV1 through the real executor,
// the real journal and the REAL zoanthrope binary. No model involved.

import assert from "node:assert/strict";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Edit } from "../../src/digest/canonical.ts";
import type { ZooPort } from "../../src/executor/executor.ts";
import { type ZooAdapter } from "../../src/zoo/adapter.ts";
import { ZooError } from "../../src/zoo/types.ts";
import { wp } from "../helpers.ts";
import { type Env, ino, makeEnv, mtimeNs, propose, RUN, T1, T2, T3 } from "./env.ts";

const SCHEMA_T1: Edit = {
  op: "replace_exact",
  path: "app/schema.py",
  old: "class Invoice:\n    customer_id: str\n    subtotal_cents: int\n",
  new: "class Invoice:\n    customer_id: str\n    subtotal_cents: int\n    discount_bps: int = 0\n",
};
const SCHEMA_T2: Edit = {
  op: "replace_exact",
  path: "app/schema.py",
  old: "    subtotal_cents: int\n    total_cents: int\n",
  new: "    subtotal_cents: int\n    discount_cents: int\n    total_cents: int\n",
};
const BILLING: Edit = { op: "write_file", path: "app/billing.py", content: '"""billing v2"""\n' };

const A1 = `${RUN}:t1`;
const tmpLeft = (env: Env) => readdirSync(join(env.ws, "app")).filter((n) => n.startsWith(".synapser-tmp-"));
const states = (env: Env, id: string) => env.journal.listEvents().filter((e) => e.entity === "action" && e.entityId === id).map((e) => e.toState);

describe("executor protocol", () => {
  let env: Env;
  let inc1: number;
  let inc2: number;
  let inc3: number;
  const start = async (opts?: Parameters<typeof makeEnv>[0]) => {
    env = await makeEnv(opts);
    inc1 = env.exec.beginSession(T1).incarnation;
    inc2 = env.exec.beginSession(T2).incarnation;
    inc3 = env.exec.beginSession(T3).incarnation;
  };
  beforeEach(async () => start());
  afterEach(async () => env.close());

  test("single file: full walk PREPARED→…→SETTLED, claims released, no temp left", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(r.status, "SETTLED");
    assert.equal(env.read("app/billing.py"), '"""billing v2"""\n');
    assert.deepEqual(r.cleanup, { registry: "CLEARED", fs: "NOT_ATTESTED" });
    assert.deepEqual(states(env, p.actionId), ["PREPARED", "CLAIMING", "CLAIMED", "EXECUTING", "APPLIED", "RELEASE_PENDING", "SETTLED"]);
    assert.deepEqual(await env.zoo.listClaims(), []);
    assert.deepEqual(tmpLeft(env), []);
    assert.equal(r.applied_files[0]?.path, "app/billing.py");
  });

  test("multi-file action applies every file and releases the whole set", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py", "app/schema.py"], [BILLING, SCHEMA_T1]);
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(r.status, "SETTLED");
    assert.match(env.read("app/schema.py"), /discount_bps: int = 0/);
    assert.equal(env.read("app/billing.py"), '"""billing v2"""\n');
    assert.deepEqual(env.journal.getActionFiles(p.actionId).map((f) => f.progress), ["APPLIED", "APPLIED"]);
    assert.deepEqual(await env.zoo.listClaims(), []);
  });

  test("create and delete operations", async () => {
    const t = { taskId: "t9", scope: ["app/new.py", "README.md"], planRevision: 1 };
    const inc = env.exec.beginSession(t).incarnation;
    const p = await propose(env, t, inc, ["app/new.py", "README.md"], [
      { op: "write_file", path: "app/new.py", content: "x = 1\n" },
      { op: "delete_file", path: "README.md" },
    ]);
    assert.deepEqual(p.files.map((f) => [f.path, f.op]), [["README.md", "delete"], ["app/new.py", "create"]]);
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc });
    assert.equal(r.status, "SETTLED");
    assert.equal(env.read("app/new.py"), "x = 1\n");
    assert.equal(existsSync(join(env.ws, "README.md")), false);
  });

  test("S01+S03 (demo schedule): the loser waits, then rebases on the winner's content", async () => {
    const pa = await propose(env, T1, inc1, ["app/schema.py"], [SCHEMA_T1]);
    const pb = await propose(env, T2, inc2, ["app/schema.py"], [SCHEMA_T2]);
    const before = env.read("app/schema.py");
    const gate = env.gate("after-executing-commit", pa.actionId);

    const a = env.exec.applyAction({ actionId: pa.actionId, requestDigest: pa.requestDigest, incarnation: inc1 });
    await gate.reached; // T1 is EXECUTING and holds the claim

    // T3 is independent and keeps making progress while T2 contends
    const p3 = await propose(env, T3, inc3, ["README.md"], [{ op: "write_file", path: "README.md", content: "# docs\n" }]);
    const r3 = await env.exec.applyAction({ actionId: p3.actionId, requestDigest: p3.requestDigest, incarnation: inc3 });
    assert.equal(r3.status, "SETTLED");

    const rb = await env.exec.applyAction({ actionId: pb.actionId, requestDigest: pb.requestDigest, incarnation: inc2 });
    assert.equal(rb.status, "WAITING_RESOURCE");
    assert.equal(rb.waiting?.holder, A1);
    assert.equal(rb.waiting?.path, "app/schema.py");
    assert.equal(rb.waiting?.purpose, `action ${pa.actionId}`);
    assert.equal(env.read("app/schema.py"), before, "the contender wrote nothing");
    assert.deepEqual((await env.zoo.listClaims(`${RUN}:t2`)).map((c) => c.path), []);

    gate.open();
    assert.equal((await a).status, "SETTLED");

    // T2 retries its OLD patch: the content changed under it → STALE_VIEW; the patch is never
    // applied to bytes it was not written against.
    const stale = await env.exec.applyAction({ actionId: pb.actionId, requestDigest: pb.requestDigest, incarnation: inc2 });
    assert.equal(stale.status, "STALE_VIEW");
    assert.match(env.read("app/schema.py"), /discount_bps/);
    assert.doesNotMatch(env.read("app/schema.py"), /discount_cents/);
    assert.deepEqual(await env.zoo.listClaims(), []);

    // T2 re-reads, proposes a NEW action on the current bytes, and it lands
    const pb2 = await propose(env, T2, inc2, ["app/schema.py"], [SCHEMA_T2]);
    assert.notEqual(pb2.actionId, pb.actionId);
    assert.equal((await env.exec.applyAction({ actionId: pb2.actionId, requestDigest: pb2.requestDigest, incarnation: inc2 })).status, "SETTLED");
    const final = env.read("app/schema.py");
    assert.match(final, /discount_bps: int = 0/);
    assert.match(final, /discount_cents: int/);
  });

  test("S01 with bounded backoff: a waiter that retries sees the holder go away", async () => {
    const pa = await propose(env, T1, inc1, ["app/schema.py"], [SCHEMA_T1]);
    const pb = await propose(env, T2, inc2, ["app/schema.py"], [SCHEMA_T2]);
    const gate = env.gate("after-executing-commit", pa.actionId);
    const a = env.exec.applyAction({ actionId: pa.actionId, requestDigest: pa.requestDigest, incarnation: inc1 });
    await gate.reached;
    const b = env.exec.applyAction({ actionId: pb.actionId, requestDigest: pb.requestDigest, incarnation: inc2 }, { maxAttempts: 8, backoffMs: 20 });
    setTimeout(() => gate.open(), 60);
    await a;
    const rb = await b;
    assert.equal(rb.status, "STALE_VIEW"); // it did wait, then correctly refused stale content
    assert.ok((env.journal.getAction(pb.actionId)?.attempt ?? 0) >= 2);
  });

  test("S02: a batch with one busy file writes none of its files and holds nothing", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py", "app/schema.py"], [BILLING, SCHEMA_T1]);
    await env.zoo.claim("someone-else", wp("app/schema.py"), "edit"); // takes it AFTER the agent read
    const billingBefore = env.read("app/billing.py");
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(r.status, "WAITING_RESOURCE");
    assert.equal(r.waiting?.holder, "someone-else");
    assert.equal(env.read("app/billing.py"), billingBefore);
    assert.deepEqual((await env.zoo.listClaims(A1)).map((c) => c.path), []);
    assert.equal((await env.zoo.claim("third", wp("app/billing.py"), "edit")).kind, "granted"); // not left locked
    assert.deepEqual(tmpLeft(env), []);
  });

  test("S03: a file changed after read_files is refused; foreign content and claims survive", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    env.write("app/billing.py", "# edited out of band\n");
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(r.status, "STALE_VIEW");
    assert.equal(env.read("app/billing.py"), "# edited out of band\n");
    assert.deepEqual(await env.zoo.listClaims(), []);
    assert.deepEqual(states(env, p.actionId), ["PREPARED", "CLAIMING", "CLAIMED", "STALE_VIEW", "RELEASE_PENDING", "SETTLED"]);
    assert.equal(env.journal.getActionFiles(p.actionId)[0]?.progress, "PENDING");
  });

  test("S04: a repeated apply returns the same outcome and touches neither disk nor journal", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const req = { actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 };
    const first = await env.exec.applyAction(req);
    const m = mtimeNs(env, "app/billing.py");
    const i = ino(env, "app/billing.py");
    const events = env.journal.listEvents().length;
    const second = await env.exec.applyAction(req);
    assert.deepEqual(second, first);
    assert.equal(mtimeNs(env, "app/billing.py"), m);
    assert.equal(ino(env, "app/billing.py"), i);
    assert.equal(env.journal.listEvents().length, events);
  });

  test("concurrent duplicate applies join the in-flight attempt: one logical application", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const req = { actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 };
    const [x, y] = await Promise.all([env.exec.applyAction(req), env.exec.applyAction(req)]);
    assert.deepEqual(x, y);
    assert.equal(states(env, p.actionId).filter((s) => s === "EXECUTING").length, 1);
  });

  test("same action_id with another body is refused and nothing is applied", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const bad = await env.exec.applyAction({ actionId: p.actionId, requestDigest: `sha256:${"0".repeat(64)}`, incarnation: inc1 });
    assert.equal(bad.error_code, "ACTION_ID_REUSED");
    assert.equal(env.journal.getAction(p.actionId)?.state, "PREPARED");
    const unknown = await env.exec.applyAction({ actionId: "act-nope", requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(unknown.error_code, "ACTION_ID_UNKNOWN");
  });

  test("S07: a request from a previous incarnation is refused; identity is kept", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const next = env.exec.beginSession(T1, "m", true).incarnation;
    assert.equal(next, inc1 + 1);
    const late = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(late.error_code, "STALE_INCARNATION");
    assert.equal(env.read("app/billing.py").includes("v2"), false);
    const rd = await env.exec.readFiles("t1", inc1, ["app/billing.py"]);
    assert.deepEqual(rd, { kind: "rejected", code: "STALE_INCARNATION" });
    // the same owner continues under the new incarnation
    const ok = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: next });
    assert.equal(ok.status, "SETTLED");
    assert.equal(env.journal.getAction(p.actionId)?.actorOwner, A1);
  });

  test("S10/S15: escapes, reserved names, symlinks and out-of-scope paths die before any claim", async () => {
    symlinkSync("/etc/hostname", join(env.ws, "app", "link.py"));
    const r = await env.exec.readFiles("t1", inc1, ["app/billing.py", "app/schema.py"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    const attempt = async (path: string) => {
      const o = await env.exec.proposePatch("t1", inc1, r.viewId, [{ op: "write_file", path, content: "x" }]);
      return o.kind === "rejected" ? o.code : "ACCEPTED";
    };
    assert.equal(await attempt("../escape.py"), "PATH_OUTSIDE_WORKSPACE");
    assert.equal(await attempt("/etc/passwd"), "PATH_OUTSIDE_WORKSPACE");
    assert.equal(await attempt(".git/config"), "PATH_RESERVED");
    assert.equal(await attempt(".zoanthrope/state.json"), "PATH_RESERVED");
    assert.equal(await attempt("app/.synapser-tmp-act-t1-1-0"), "PATH_RESERVED");
    assert.equal(await attempt("app/link.py"), "PATH_SYMLINK");
    assert.equal(await attempt("app/client.py"), "OUT_OF_SCOPE"); // contained, but not T1's scope
    assert.equal(env.journal.listNonTerminal().length, 0, "no action was even prepared");
    assert.deepEqual(await env.zoo.listClaims(), []);
    assert.equal((await env.zoo.auditLog()).some((e) => JSON.stringify(e).includes("passwd")), false);
    // reads obey containment too
    assert.deepEqual(await env.exec.readFiles("t1", inc1, ["/etc/passwd"]), { kind: "rejected", code: "PATH_OUTSIDE_WORKSPACE", detail: "/etc/passwd" });
  });

  test("patches that do not apply never become actions", async () => {
    const r = await env.exec.readFiles("t1", inc1, ["app/billing.py"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    const o = await env.exec.proposePatch("t1", inc1, r.viewId, [{ op: "replace_exact", path: "app/billing.py", old: "does not exist", new: "x" }]);
    assert.deepEqual(o, { kind: "rejected", code: "PATCH_DOES_NOT_APPLY", detail: "app/billing.py" });
    assert.equal(env.journal.countActionsForTask("t1"), 0);
  });

  test("S09: coordination service gone → no write, action left in CLAIMING for recovery", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const before = env.read("app/billing.py");
    await env.zoo.close(); // the real process is terminated
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(r.status, "UNAVAILABLE");
    assert.match(r.error_code ?? "", /^COORDINATION_/);
    assert.equal(env.read("app/billing.py"), before);
    assert.equal(env.journal.getAction(p.actionId)?.state, "CLAIMING");
    assert.deepEqual(tmpLeft(env), []);
  });

  test("nothing can be prepared blind: a foreign editor makes read_files wait, not guess", async () => {
    await env.zoo.claim("squatter", wp("app/billing.py"), "edit");
    const r = await env.exec.readFiles("t1", inc1, ["app/billing.py"]);
    assert.equal(r.kind, "waiting");
    assert.equal(env.journal.countActionsForTask("t1"), 0);
  });

  test("INV1: no rename ever happens without a live edit claim and an EXECUTING journal state", async () => {
    await env.close();
    const seen: string[] = [];
    let e2!: Env;
    e2 = await makeEnv({
      beforeRename: async ({ actionId, actor, path }) => {
        const claims = await e2.zoo.listClaims(actor);
        const c = claims.find((x) => x.path === path);
        assert.ok(c && c.intent === "edit", `no edit claim for ${path} at rename time`);
        assert.equal(e2.journal.getAction(actionId)?.state, "EXECUTING");
        seen.push(path);
      },
    });
    env = e2;
    inc1 = env.exec.beginSession(T1).incarnation;
    inc2 = env.exec.beginSession(T2).incarnation;
    inc3 = env.exec.beginSession(T3).incarnation;
    const p = await propose(env, T1, inc1, ["app/billing.py", "app/schema.py"], [BILLING, SCHEMA_T1]);
    assert.equal((await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 })).status, "SETTLED");
    assert.deepEqual(seen, ["app/billing.py", "app/schema.py"]);
  });

  test("a read in the middle of our own write is refused, and the edit claim stays in the registry", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const gate = env.gate("after-executing-commit", p.actionId);
    const a = env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    await gate.reached;
    const rd = await env.exec.readFiles("t1", inc1, ["app/billing.py"]);
    assert.deepEqual(rd, { kind: "rejected", code: "BUSY_OWN_ACTION", detail: "app/billing.py" });
    const claims = await env.zoo.listClaims(A1);
    assert.deepEqual(claims.map((c) => [c.path, c.intent]), [["app/billing.py", "edit"]]);
    // an untouched file is still readable meanwhile
    assert.equal((await env.exec.readFiles("t1", inc1, ["app/schema.py"])).kind, "ok");
    assert.deepEqual((await env.zoo.listClaims(A1)).map((c) => c.path), ["app/billing.py"]);
    gate.open();
    assert.equal((await a).status, "SETTLED");
  });

  test("read_files waits on a foreign editor and uses its own identity", async () => {
    await env.zoo.claim("squatter", wp("app/billing.py"), "edit", { purpose: "holding" });
    const r = await env.exec.readFiles("t1", inc1, ["app/billing.py"]);
    assert.deepEqual(r, { kind: "waiting", holder: "squatter", path: "app/billing.py", purpose: "holding", holderStale: false });
    assert.deepEqual((await env.zoo.listClaims(`${A1}#r`)), []);
  });

  test("S16: release that cannot be confirmed leaves the result valid but cleanup UNVERIFIED and the files blocked", async () => {
    await env.close();
    env = await makeEnv({
      zoo: (real: ZooAdapter): ZooPort => ({
        claim: (...a) => real.claim(...a),
        listClaims: (a) => real.listClaims(a),
        rejoin: (a) => real.rejoin(a),
        release: async (agent, files) => {
          if (agent.endsWith(":t1")) throw new ZooError("TIMEOUT", "release swallowed");
          return real.release(agent, files);
        },
      }),
    });
    inc1 = env.exec.beginSession(T1).incarnation;
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const r = await env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    assert.equal(env.read("app/billing.py"), '"""billing v2"""\n'); // the write itself is real
    assert.equal(r.state, "RELEASE_PENDING");
    assert.equal(r.status, "UNAVAILABLE");
    assert.deepEqual(r.cleanup, { registry: "UNVERIFIED", fs: "NOT_ATTESTED" });
    assert.equal(r.applied_files.length, 1);
  });

  test("last line of defense: bytes that change after VERIFY are never overwritten (no recovery involved)", async () => {
    const p = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    const gate = env.gate("after-executing-commit", p.actionId);
    const a = env.exec.applyAction({ actionId: p.actionId, requestDigest: p.requestDigest, incarnation: inc1 });
    await gate.reached; // VERIFY passed; the action is EXECUTING and has not written yet
    env.write("app/billing.py", "# foreign write in the gap\n");
    gate.open();
    const r = await a;
    assert.equal(r.status, "RECOVERY_REQUIRED");
    assert.equal(r.error_code, "OBSERVED_FOREIGN_CONTENT");
    assert.equal(env.read("app/billing.py"), "# foreign write in the gap\n");
    const ev = env.journal.listEvents().find((e) => e.toState === "RECOVERY_REQUIRED") as { data: { evidence: string } };
    assert.equal(env.journal.artifacts.get(ev.data.evidence).toString(), "# foreign write in the gap\n");
    assert.deepEqual(tmpLeft(env), []);
  });

  test("files of a RECOVERY_REQUIRED action block new work on them", async () => {
    const p1 = await propose(env, T1, inc1, ["app/billing.py"], [BILLING]);
    env.journal.tx((t) => {
      t.transition(RUN, p1.actionId, "PREPARED", "CLAIMING");
      t.transition(RUN, p1.actionId, "CLAIMING", "RECOVERY_REQUIRED", { errorCode: "TEST" });
    });
    const p2 = await propose(env, T3, inc3, ["app/billing.py"], [BILLING]).catch((e) => e);
    // T3's scope excludes app/billing.py → rejected earlier; use a task that may touch it
    assert.ok(p2 instanceof Error);
    const t = { taskId: "t7", scope: ["app/billing.py"], planRevision: 1 };
    const inc = env.exec.beginSession(t).incarnation;
    const p3 = await propose(env, t, inc, ["app/billing.py"], [{ op: "write_file", path: "app/billing.py", content: "y\n" }]);
    const r = await env.exec.applyAction({ actionId: p3.actionId, requestDigest: p3.requestDigest, incarnation: inc });
    assert.equal(r.error_code, "BLOCKED_BY_RECOVERY");
    assert.equal(r.status, "REJECTED");
    assert.deepEqual(await env.zoo.listClaims(), []);
  });
});
