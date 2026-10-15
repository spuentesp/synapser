// THE CONTRACT BEHIND THE A/B (docs/plans/09). Two agents read the same file at the same base and
// both edit it, in one fixed interleaving. Same loop, same tools, same scripted decisions — only
// the WriteGateway differs. Naive: I1 fails and one edit is GONE. Synapser: one STALE_VIEW, a
// re-read, and both edits land, with every invariant holding.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runTask, type TaskSpec } from "../../src/agents/native/loop.ts";
import { checkAcceptance, checkChain, checkGrantBeforeWrite, checkLineage, digestOnDisk, executorTrace, lostLines, type WriteRecord } from "../../src/audit/invariants.ts";
import { NaiveGateway } from "../../src/bench/naive-gateway.ts";
import type { DigestOrAbsent } from "../../src/digest/file.ts";
import type { WriteGateway } from "../../src/executor/gateway.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { call, lastTool, ScriptedModel } from "../agent/scripted.ts";

const SCHEMA = "app/schema.py";
const A: TaskSpec = { taskId: "ta", objective: "add discount_bps to Invoice", scope: [SCHEMA], criteria: ["Invoice has discount_bps"], planRevision: 1 };
const B: TaskSpec = { taskId: "tb", objective: "add discount_cents to Receipt", scope: [SCHEMA], criteria: ["Receipt has discount_cents"], planRevision: 1 };
const A_OLD = "    customer_id: str\n    subtotal_cents: int\n\n\n@dataclass(frozen=True)\nclass Receipt:";
const A_NEW = "    customer_id: str\n    subtotal_cents: int\n    discount_bps: int = 0\n\n\n@dataclass(frozen=True)\nclass Receipt:";
const B_OLD = "    subtotal_cents: int\n    total_cents: int";
const B_NEW = "    subtotal_cents: int\n    discount_cents: int = 0\n    total_cents: int";

const latch = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("lost update: same agents, same interleaving, two write paths", () => {
  let env: Env;
  let exTrace: ReturnType<typeof executorTrace>;
  beforeEach(async () => {
    // the trace hook needs the journal, which makeEnv creates: indirect through a late-bound ref
    let hook: ReturnType<typeof executorTrace>["hook"] | null = null;
    env = await makeEnv({ beforeRename: (i) => hook?.(i) });
    exTrace = executorTrace(env.journal, env.ws);
    hook = exTrace.hook;
  });
  afterEach(async () => env.close());

  /** A reads → B reads → A applies → B applies → (B reacts) → both finish. Deterministic. */
  type Opts = { aEdit?: { old: string; new: string }; bFirst?: unknown[] };
  async function interleave(gw: WriteGateway, o: Opts = {}) {
    const aEdit = o.aEdit ?? { old: A_OLD, new: A_NEW };
    const bRead = latch();
    const aDone = latch();
    const modelA = new ScriptedModel((_m, n) => {
      if (n === 1) return { calls: [call("read_files", { paths: [SCHEMA] })] };
      if (n === 2) {
        return bRead.p.then(() => ({ calls: [call("replace_in_file", { path: SCHEMA, ...aEdit }), call("apply_changes", {})] }));
      }
      aDone.open();
      return { calls: [call("finish", { summary: "A done" })] };
    });
    const modelB = new ScriptedModel((m, n) => {
      if (n === 1) {
        bRead.open();
        return { calls: [call("read_files", { paths: [SCHEMA] })] };
      }
      if (n === 2) {
        return aDone.p.then(() => ({ calls: (o.bFirst as never) ?? [call("replace_in_file", { path: SCHEMA, old: B_OLD, new: B_NEW }), call("apply_changes", {})] }));
      }
      const last = lastTool(m);
      if (last?.status === "STALE_VIEW") return { calls: [call("read_files", { paths: [SCHEMA] })] };
      if (last?.files || last?.error === "READ_FIRST") return { calls: [call("replace_in_file", { path: SCHEMA, old: B_OLD, new: B_NEW }), call("apply_changes", {})] };
      return { calls: [call("finish", { summary: "B done" })] };
    });
    const mk = (model: ScriptedModel) => ({ model, executor: gw, journal: env.journal, runId: RUN });
    const [ra, rb] = await Promise.all([runTask(mk(modelA), A), runTask(mk(modelB), B)]);
    return { ra, rb, modelB };
  }

  const initial = (): Map<string, DigestOrAbsent> => new Map([[SCHEMA, digestOnDisk(env.ws, SCHEMA) as DigestOrAbsent]]);
  const schema = () => readFileSync(join(env.ws, SCHEMA), "utf8");

  test("CONTROL (naive shared tree): I1 fails — A's edit is silently destroyed, and both agents report success", async () => {
    const base = initial();
    const gw = new NaiveGateway({ workspace: env.ws, runId: RUN });
    const { ra, rb } = await interleave(gw);
    assert.equal(ra.status, "FINISHED");
    assert.equal(rb.status, "FINISHED", "nothing told B that anything was wrong");

    const v = checkLineage(gw.trace, base);
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.equal(v[0]!.code, "LOST_UPDATE");
    assert.equal(v[0]!.detail["writer"], `${RUN}:tb`);
    assert.match(schema(), /discount_cents/);
    assert.doesNotMatch(schema(), /discount_bps/, "A's change is gone");
    assert.deepEqual(v[0]!.detail["lostLines"], ["discount_bps: int = 0"], "and the checker names exactly what was destroyed");
  });

  test("SYNAPSER (executor): one STALE_VIEW, a re-read, both edits land; I1–I5 hold", async () => {
    const base = initial();
    const { ra, rb, modelB } = await interleave(env.exec);
    assert.equal(ra.status, "FINISHED");
    assert.equal(rb.status, "FINISHED");
    assert.deepEqual(rb.actions.map((a) => a.status), ["STALE_VIEW", "SETTLED"]);
    assert.equal(modelB.calls, 3, "B never saw the stale view: the loop re-anchored its replacement itself");
    assert.equal(env.journal.listEvents().filter((e) => e.entity === "agent_step" && (e.data as { tool?: string }).tool === "rebase").length, 1, "and the re-anchor is on the ledger");

    assert.match(schema(), /discount_bps/);
    assert.match(schema(), /discount_cents/);
    assert.equal(exTrace.trace.length, 2);
    const v = [...checkLineage(exTrace.trace, base), ...checkGrantBeforeWrite(env.journal), ...checkAcceptance(env.journal), ...checkChain(env.journal)];
    assert.deepEqual(v, []);
    assert.equal(exTrace.trace.flatMap((w) => lostLines(w)).length, 0);
  });

  const sawStale = (m: ScriptedModel) => m.seen.some((msgs) => msgs.some((x) => x.role === "tool" && /STALE_VIEW/.test(x.content ?? "")));
  const rebased = () => env.journal.listEvents().filter((e) => e.entity === "agent_step" && (e.data as { tool?: string }).tool === "rebase").length;

  test("re-anchor is NOT used for a whole-file write: the model is told, and A's edit survives", async () => {
    const base = initial();
    const whole = readFileSync(join(env.ws, SCHEMA), "utf8").replace(B_OLD, B_NEW);
    const { rb, modelB } = await interleave(env.exec, { bFirst: [call("write_file", { path: SCHEMA, content: whole }), call("apply_changes", {})] });
    assert.equal(rebased(), 0);
    assert.ok(sawStale(modelB), "the model was shown STALE_VIEW");
    assert.equal(rb.status, "FINISHED");
    assert.match(schema(), /discount_bps/);
    assert.match(schema(), /discount_cents/);
    assert.deepEqual(checkLineage(exTrace.trace, base), []);
  });

  test("re-anchor is NOT used when the replaced text changed under it: the model is told instead", async () => {
    const base = initial();
    // A rewrites exactly the region B wants to replace, so B's `old` no longer matches
    const aEdit = { old: B_OLD, new: "    subtotal_cents: int\n    fee_cents: int\n    total_cents: int" };
    const { rb, modelB } = await interleave(env.exec, { aEdit });
    assert.equal(rebased(), 0, "nothing to re-anchor: old text is gone");
    assert.ok(sawStale(modelB));
    assert.equal(rb.actions[0]!.status, "STALE_VIEW");
    assert.deepEqual(checkLineage(exTrace.trace, base), []);
  });

  test("the checker is not vacuous: it flags a hand-made lost update and a hand-made foreign overwrite", () => {
    const d = (c: string) => `sha256:${c.repeat(64)}` as DigestOrAbsent;
    const trace: WriteRecord[] = [
      { seq: 1, path: "f", actor: "a", basedOn: d("0"), onDiskBefore: d("0"), written: d("1") },
      { seq: 2, path: "f", actor: "b", basedOn: d("0"), onDiskBefore: d("1"), written: d("2") }, // based on 0, tree had 1
      { seq: 3, path: "f", actor: "c", basedOn: d("2"), onDiskBefore: d("9"), written: d("3") }, // someone changed the file under us
    ];
    const v = checkLineage(trace, new Map([["f", d("0")]]));
    assert.deepEqual(v.map((x) => `${x.invariant}:${x.code}@${String(x.detail["seq"])}`), ["I1:LOST_UPDATE@2", "I3:UNPREDICTED_BYTES_OVERWRITTEN@3"]);
    assert.deepEqual(checkLineage(trace.slice(0, 1), new Map([["f", d("0")]])), []);
  });
});

describe("I4 checker", () => {
  test("DONE through a passing validation is accepted; DONE without evidence, or through a failing one, is flagged", async () => {
    const env = await makeEnv();
    try {
      env.journal.tx((t) => {
        t.insertMission({ runId: RUN, objective: "x", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
        for (const id of ["w1", "w2", "w3", "val-ok", "val-bad"]) {
          t.insertTask({ runId: RUN, taskId: id, actorOwner: `${RUN}:${id}`, priority: 0, scope: [], spec: { kind: id.startsWith("val") ? "validation" : "agent", objective: id, criteria: [] }, planRevision: 1, deps: [] });
        }
        t.insertValidation({ validationId: "v1", runId: RUN, taskId: "val-ok", command: "unit", snapshotDigest: "s", scopeDigest: "s" });
        t.insertValidation({ validationId: "v2", runId: RUN, taskId: "val-bad", command: "unit", snapshotDigest: "s", scopeDigest: "s" });
      });
      const setDone = (id: string, by?: string) =>
        env.journal.tx((t) => {
          t.setTaskState(RUN, id, "PENDING", "DONE", by ? { by } : {});
        });
      env.journal.tx((t) => {
        t.finishValidation("v1", RUN, { exitCode: 0, valid: true, outputBlob: null });
        t.finishValidation("v2", RUN, { exitCode: 1, valid: true, outputBlob: null });
      });
      setDone("w1", "val-ok");
      setDone("w2", "val-bad");
      setDone("w3");
      const v = checkAcceptance(env.journal).map((x) => x.where).sort();
      assert.deepEqual(v, ["w2", "w3"]);
    } finally {
      await env.close();
    }
  });
});
