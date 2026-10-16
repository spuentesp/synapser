// Plan 12: the API is a deterministic projection of the ledger (U2, U3), cannot write to the
// workspace (U1), accepts only fresh approvals (U4), and exposes no content by default (U5).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApi, type ApiServer } from "../../src/api/server.ts";
import { currentPlanDigest, requestApproval } from "../../src/orchestration/gates.ts";
import { buildScenario } from "../audit/scenario.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

describe("API", () => {
  let env: Env;
  let api: ApiServer;
  let base: string;
  beforeEach(async () => {
    env = await makeEnv();
    await buildScenario(env);
    api = createApi({ stateDir: env.state, journals: new Map([[RUN, env.journal]]), ssePollMs: 20 });
    base = `http://127.0.0.1:${await api.listen(0)}`;
  });
  afterEach(async () => {
    await api.close();
    await env.close();
  });
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const J = async (p: string): Promise<any> => JSON.parse((await get(p)).text);

  test("lists the run with its head, chain status and pending approvals", async () => {
    const { runs } = await J("/api/runs");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, RUN);
    assert.equal(runs[0].chainOk, true);
    assert.match(runs[0].head, /^sha256:/);
  });

  test("U3: every endpoint is deterministic — the same ledger gives the same bytes", async () => {
    const paths = ["/api/runs", `/api/runs/${RUN}/state`, `/api/runs/${RUN}/timeline`, `/api/runs/${RUN}/cost?by=profile`, `/api/runs/${RUN}/waste`, `/api/runs/${RUN}/coordination`, `/api/runs/${RUN}/verify`, `/api/runs/${RUN}/export`];
    for (const p of paths) {
      const a = await get(p);
      const b = await get(p);
      assert.equal(a.status, 200, p);
      assert.equal(a.text, b.text, p);
    }
  });

  test("U2: every aggregate cites the ledger events behind it, and the citations are real", async () => {
    const events = new Map(env.journal.listEvents().map((e) => [e.seq, e]));
    const cost = await J(`/api/runs/${RUN}/cost?by=profile`);
    assert.ok(cost.rows.length >= 3);
    for (const row of cost.rows) {
      assert.ok(row.evidence.seqs.length > 0, row.key);
      for (const s of row.evidence.seqs) {
        const e = events.get(s)!;
        assert.ok(e, `seq ${s} exists`);
        assert.equal(e.entity === "agent_run" || e.entity === "agent_run_integration", true, `${row.key} cites an agent-run event, got ${e.entity}`);
      }
    }
    const state = await J(`/api/runs/${RUN}/state`);
    for (const a of state.agents) for (const s of a.evidence.seqs) assert.ok(events.has(s));
    const w = await J(`/api/runs/${RUN}/waste`);
    assert.ok(w.wastedRuns.length >= 1);
    for (const r of w.wastedRuns) assert.ok(r.evidence.seqs.length > 0);
    const coord = await J(`/api/runs/${RUN}/coordination`);
    for (const r of coord.rows) assert.ok(r.evidence.seqs.length > 0, r.taskId);
  });

  test("U4: an approval needs the session token, the CURRENT digest and a pending gate; it is recorded with its actor", async () => {
    const digest = currentPlanDigest(env.journal);
    requestApproval(env.journal, RUN, "t9", digest, "deploy the thing");
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/runs/${RUN}/approvals/t9`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ decision: "APPROVED", planDigest: digest })).status, 401, "no token");
    const tok = { "x-synapser-token": api.token };
    assert.equal((await post({ decision: "APPROVED", planDigest: digest }, { ...tok, origin: "http://evil.example" })).status, 403, "cross-origin");
    assert.equal((await post({ decision: "MAYBE", planDigest: digest }, tok)).status, 400);
    const stale = await post({ decision: "APPROVED", planDigest: "sha256:old" }, tok);
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, "STALE_DIGEST");
    assert.equal((await J(`/api/runs/${RUN}/state`)).pendingApprovals.includes("t9"), true);

    const ok = await post({ decision: "APPROVED", planDigest: digest, actor: "ana" }, tok);
    assert.equal(ok.status, 200);
    const ev = env.journal.listEvents().filter((e) => e.entity === "approval" && e.entityId === "t9");
    assert.deepEqual(ev.map((e) => e.toState), ["PENDING", "APPROVED"]);
    assert.equal((ev[1]!.data as { actor: string }).actor, "ana");
    assert.equal((await post({ decision: "REJECTED", planDigest: digest }, tok)).status, 409, "already decided");
    assert.equal((await J(`/api/runs/${RUN}/verify`)).ok, true, "the chain still verifies");
  });

  test("U4: URL-encoded self-bound condition approval keys can be decided", async () => {
    const digest = "sha256:condition-snapshot";
    requestApproval(env.journal, RUN, "cond:release-check", digest, "release condition");
    const response = await fetch(`${base}/api/runs/${RUN}/approvals/cond%3Arelease-check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-synapser-token": api.token },
      body: JSON.stringify({ decision: "APPROVED", planDigest: digest, actor: "ana" }),
    });
    assert.equal(response.status, 200, await response.text());
    const decision = env.journal.listEvents().find((e) => e.entity === "approval" && e.entityId === "cond:release-check" && e.toState === "APPROVED");
    assert.equal((decision?.data as { actor?: string } | undefined)?.actor, "ana");
  });

  test("U1: the server cannot write to the workspace — it does not import the executor, and POST only appends approvals", async () => {
    const src = readFileSync(new URL("../../src/api/server.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^import /.test(l)).join("\n");
    assert.doesNotMatch(imports, /executor|fs-applier|child_process|zoo|workspace\//, "no path to the executor or the workspace");
    const named = /import \{([^}]*)\} from "node:fs"/.exec(src)![1]!.split(",").map((x) => x.trim());
    assert.deepEqual(named.filter((n) => /write|rename|unlink|rm|mkdir|copy|append|symlink/i.test(n)), [], "node:fs is imported read-only");
    const before = readdirSync(env.ws).sort();
    const digest = currentPlanDigest(env.journal);
    requestApproval(env.journal, RUN, "t8", digest); // the gate (and its challenge) exist BEFORE the request under test
    const eventsBefore = env.journal.listEvents().length;
    await fetch(`${base}/api/runs/${RUN}/approvals/t8`, { method: "POST", headers: { "content-type": "application/json", "x-synapser-token": api.token }, body: JSON.stringify({ decision: "APPROVED", planDigest: digest }) });
    assert.deepEqual(readdirSync(env.ws).sort(), before, "the workspace is untouched");
    const added = env.journal.listEvents().slice(eventsBefore);
    assert.deepEqual(added.map((e) => `${e.entity}:${e.toState}`), ["approval:APPROVED"], "the POST appended exactly the decision");
  });

  test("U5: no prompt text or file contents leave by default", async () => {
    const bodies = [`/api/runs/${RUN}/state`, `/api/runs/${RUN}/timeline`, `/api/runs/${RUN}/cost?by=task`, `/api/runs/${RUN}/waste`, `/api/runs/${RUN}/coordination`, `/api/runs/${RUN}/export`];
    for (const p of bodies) {
      const t = (await get(p)).text;
      for (const secret of ["# native marker", "# edited by the agent", "client edit", "# human edit", "SECRET-REASONING"]) assert.equal(t.includes(secret), false, `${p} leaked ${secret}`);
    }
  });

  test("verify reports a tampered ledger with the first bad seq", async () => {
    const ok = await J(`/api/runs/${RUN}/verify`);
    assert.equal(ok.ok, true);
    const db = new DatabaseSync(join(env.state, RUN, "journal.db"));
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.prepare("UPDATE events SET data_json = ? WHERE seq = 5").run('{"tampered":true}');
    db.close();
    const bad = await J(`/api/runs/${RUN}/verify`);
    assert.equal(bad.ok, false);
    assert.equal(bad.firstBadSeq, 5);
  });

  test("hostile inputs: unknown run 404, traversal 400/404, bad method 405, static traversal blocked", async () => {
    assert.equal((await get("/api/runs/nope/state")).status, 404);
    assert.equal((await get("/api/runs/..%2f..%2fetc/state")).status, 400);
    assert.equal((await get(`/api/runs/${RUN}/nonsense`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/${RUN}/state`, { method: "DELETE" })).status, 405);
    assert.equal((await get("/..%2f..%2fpackage.json")).status, 404);
    assert.equal((await get("/api/runs/" + RUN + "/why")).status, 400);
  });

  test("SSE: replays from a seq, then streams events as the ledger grows", async () => {
    const got: { id: number; summary: string }[] = [];
    const req = httpGet(`${base}/api/runs/${RUN}/events?since=0`, (res) => {
      assert.match(String(res.headers["content-type"]), /text\/event-stream/);
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block);
          if (data) got.push(JSON.parse(data[1] as string));
        }
      });
    });
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && got.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const total = env.journal.listEvents().length;
    await waitFor(total);
    assert.equal(got.length, total, "full replay");
    env.journal.tx((t) => t.event(RUN, "alert", "late", null, "COST_UNKNOWN", { profile: "x" }));
    await waitFor(total + 1);
    assert.equal(got.at(-1)!.summary.includes("COST_UNKNOWN") || String(JSON.stringify(got.at(-1))).includes("COST_UNKNOWN"), true);
    req.destroy();
  });
});
