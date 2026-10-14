// Plan 13 §4: the workflow model, its checkers, and C1/C3/C4.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { baselineOf, changedPaths, evaluateWorkflow, type CheckerContext } from "../../src/workflow/checkers.ts";
import { checkSameSnapshot, checkWaivers, checkWorkflowDone } from "../../src/workflow/invariants.ts";
import { matchesPattern, validateWorkflow, type Workflow } from "../../src/workflow/model.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const COMMANDS = new Set(["unit", "oracle"]);
const base = (over: Record<string, unknown> = {}) => ({
  id: "wf-1", title: "Add discounts", description: "Add per-customer discounts to the billing library", goals: ["discount applied"],
  nonGoals: ["do not touch the README"],
  conditions: [{ id: "tests", statement: "unit tests pass", checker: { kind: "command", commandId: "unit" } }],
  ...over,
});

describe("validateWorkflow", () => {
  const root = new URL("../../fixtures/billing/baseline", import.meta.url).pathname;
  const check = (raw: unknown) => validateWorkflow(raw, { workspaceRoot: root, commandIds: COMMANDS, profileIds: new Set(["adv"]) });
  const errs = (raw: unknown) => {
    const r = check(raw);
    return r.ok ? [] : r.errors.join(" | ");
  };

  test("a complete workflow is accepted and normalised (non-goal strings become objects, required defaults to true)", () => {
    const r = check(base());
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.workflow.nonGoals, [{ statement: "do not touch the README" }]);
    assert.equal(r.workflow.conditions[0]!.required, true);
  });

  test("it refuses what could never be DONE or could not be checked", () => {
    assert.match(String(errs(base({ conditions: [] }))), /non-empty array/);
    assert.match(String(errs(base({ conditions: [{ id: "x", statement: "info only", required: false, checker: { kind: "file", path: "a.py", assert: "exists" } }] }))), /required and not waived/);
    assert.match(String(errs(base({ conditions: [{ id: "tests", statement: "tests", checker: { kind: "command", commandId: "rm-rf" } }] }))), /not an allowlisted command/);
    assert.match(String(errs(base({ conditions: [{ id: "a", statement: "x file", checker: { kind: "file", path: "../etc/passwd", assert: "exists" } }] }))), /rejected/);
    assert.match(String(errs(base({ conditions: [{ id: "a", statement: "same", checker: { kind: "file", path: "a.py", assert: "exists" } }, { id: "a", statement: "dup", checker: { kind: "file", path: "b.py", assert: "exists" } }] }))), /duplicated/);
    assert.match(String(errs(base({ title: "x" }))), /title/);
  });

  test("E3: a review (an agent's judgement) cannot be REQUIRED without an explicit, attributed acceptance", () => {
    const review = { id: "rv", statement: "the change is idiomatic", checker: { kind: "review", profile: "adv", rubric: "judge the style" } };
    const withTests = base().conditions;
    assert.match(String(errs(base({ conditions: [...withTests, { ...review, required: true }] }))), /cannot make a REQUIRED condition pass by itself/);
    assert.ok(check(base({ conditions: [...withTests, { ...review, required: false }] })).ok, "informational is fine");
    assert.ok(check(base({ conditions: [...withTests, { ...review, required: true, secondaryAccepted: { actor: "ana", reason: "style is subjective" } }] })).ok);
    assert.match(String(errs(base({ conditions: [...withTests, { ...review, checker: { kind: "review", profile: "ghost", rubric: "judge" }, required: false }] }))), /not a known profile/);
  });

  test("non-goals can carry a mechanised guard; only diff/file/command guards are allowed", () => {
    const ok = check(base({ nonGoals: [{ statement: "no changes to docs", guard: { kind: "diff", forbid: ["docs/", "README.md"] } }] }));
    assert.ok(ok.ok);
    assert.match(String(errs(base({ nonGoals: [{ statement: "x y z", guard: { kind: "approval", prompt: "is it ok" } }] }))), /not allowed here/);
  });

  test("path patterns: exact, dir prefix, * within a segment, ** across segments", () => {
    assert.equal(matchesPattern("README.md", "README.md"), true);
    assert.equal(matchesPattern("docs/a/b.md", "docs/"), true);
    assert.equal(matchesPattern("app/x.py", "app/*.py"), true);
    assert.equal(matchesPattern("app/sub/x.py", "app/*.py"), false);
    assert.equal(matchesPattern("app/sub/x.py", "app/**/*.py"), true);
    assert.equal(matchesPattern("src/.env", "**/.env"), true);
  });
});

describe("evaluation and invariants", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const wf = (over: Record<string, unknown> = {}): Workflow => {
    const r = validateWorkflow(base(over), { workspaceRoot: env.ws, commandIds: COMMANDS, profileIds: new Set(["adv"]) });
    assert.ok(r.ok, JSON.stringify(r));
    return r.workflow;
  };
  const ctx = (over: Partial<CheckerContext> = {}): CheckerContext => ({
    journal: env.journal, runId: RUN, workspaceRoot: env.ws, taskId: "validate",
    baseline: baselineOf(env.ws),
    validation: { run: async (id) => ({ validationId: "v", commandId: id, exitCode: 0, timedOut: false, durationMs: 1, snapshotDigest: "s", valid: true, passed: true, networkIsolated: true, runner: "local" as const, stdout: "", stderr: "", outputBlob: "", note: null }) },
    awaitApproval: async () => "APPROVED",
    ...over,
  });

  test("diff / file checkers judge the tree against the baseline, and a guard violation blocks DONE", async () => {
    const w = wf({
      conditions: [
        { id: "changed-billing", statement: "billing.py changes", checker: { kind: "diff", require: ["app/billing.py"] } },
        { id: "has-marker", statement: "the schema documents it", checker: { kind: "file", path: "app/schema.py", assert: { contains: "discount" } } },
      ],
      nonGoals: [{ statement: "README untouched", guard: { kind: "diff", forbid: ["README.md"] } }],
    });
    const c = ctx();
    let r = await evaluateWorkflow(w, c);
    assert.equal(r.satisfied, false);
    assert.deepEqual(r.results.map((x) => `${x.id}:${x.status}`), ["changed-billing:UNSATISFIED", "has-marker:UNSATISFIED", "guard:0:SATISFIED"]);

    env.write("app/billing.py", `${env.read("app/billing.py")}\n# discount support\n`);
    env.write("app/schema.py", `${env.read("app/schema.py")}\n# discount_bps\n`);
    r = await evaluateWorkflow(w, c);
    assert.equal(r.satisfied, true, JSON.stringify(r.results));

    env.write("README.md", "touched");
    r = await evaluateWorkflow(w, c);
    assert.equal(r.satisfied, false);
    const g = r.results.find((x) => x.id === "guard:0")!;
    assert.equal(g.status, "UNSATISFIED");
    assert.match(g.detail, /forbidden path\(s\) changed: README.md/);
    assert.deepEqual(changedPaths(env.ws, c.baseline), ["README.md", "app/billing.py", "app/schema.py"]);
  });

  test("C4: one round judges every condition on the SAME snapshot", async () => {
    const w = wf({ conditions: [{ id: "a", statement: "file exists a", checker: { kind: "file", path: "app/billing.py", assert: "exists" } }, { id: "b", statement: "tests pass", checker: { kind: "command", commandId: "unit" } }] });
    const r = await evaluateWorkflow(w, ctx());
    assert.equal(new Set(r.results.map((x) => x.snapshot)).size, 1);
    assert.equal(r.results[0]!.snapshot, r.snapshot);
  });

  test("E3 in evaluation: a passing review is secondary evidence and does NOT satisfy a required condition unless accepted", async () => {
    const mk = (secondary: boolean) =>
      wf({
        conditions: [
          { id: "rv", statement: "reviewed ok", required: true, checker: { kind: "review", profile: "adv", rubric: "judge it" }, ...(secondary ? { secondaryAccepted: { actor: "ana", reason: "subjective" } } : { waivedBy: undefined }) },
        ],
      });
    // validateWorkflow refuses the unaccepted required review, so build the unaccepted one directly
    const accepted = mk(true);
    const unaccepted: Workflow = { ...accepted, conditions: [{ ...accepted.conditions[0]!, secondaryAccepted: undefined } as never] };
    const review = async () => ({ verdict: "pass" as const, text: "looks good" });
    const a = await evaluateWorkflow(accepted, ctx({ review }));
    assert.equal(a.results[0]!.status, "SATISFIED");
    assert.equal(a.results[0]!.evidence, "secondary");
    const u = await evaluateWorkflow(unaccepted, ctx({ review }));
    assert.equal(u.results[0]!.status, "UNSATISFIED");
    assert.match(u.results[0]!.detail, /secondary evidence is not accepted/);
  });

  test("waived conditions are not enforced but are visible and attributed (C3); informational ones never block", async () => {
    const w = wf({
      conditions: [
        { id: "tests", statement: "tests pass", checker: { kind: "command", commandId: "unit" } },
        { id: "w", statement: "needs a file nobody made", checker: { kind: "file", path: "x.py", assert: "exists" }, waivedBy: { actor: "ana", reason: "out of scope for now" } },
        { id: "nice", statement: "a nice-to-have file", required: false, checker: { kind: "file", path: "y.py", assert: "exists" } },
      ],
    });
    const r = await evaluateWorkflow(w, ctx());
    assert.deepEqual(r.results.map((x) => x.status), ["SATISFIED", "WAIVED", "INFO_FAIL"]);
    assert.equal(r.satisfied, true);
    assert.match(r.results[1]!.detail, /waived by ana: out of scope/);
  });

  test("an approval condition is bound to the snapshot and records a human decision", async () => {
    const w = wf({ conditions: [{ id: "ok", statement: "a human signed off", checker: { kind: "approval", prompt: "ship it?" } }] });
    const seen: string[] = [];
    const r = await evaluateWorkflow(w, ctx({ awaitApproval: async (key, snapshot) => (seen.push(`${key}@${snapshot.slice(0, 8)}`), "APPROVED") }));
    assert.equal(r.results[0]!.status, "SATISFIED");
    assert.equal(r.results[0]!.evidence, "human");
    assert.match(seen[0]!, /^cond:ok@sha256:/);
    const rej = await evaluateWorkflow(w, ctx({ awaitApproval: async () => "REJECTED" }));
    assert.equal(rej.results[0]!.status, "UNSATISFIED");
  });

  test("C1/C3/C4 checkers flag a DONE with an unmet required condition, mixed snapshots, and an unattributed waiver", () => {
    const w = wf({ conditions: [{ id: "tests", statement: "tests pass", checker: { kind: "command", commandId: "unit" } }, { id: "w", statement: "waived one", checker: { kind: "file", path: "x.py", assert: "exists" }, waivedBy: { actor: "ana", reason: "later" } }] });
    env.journal.tx((t) => {
      t.event(RUN, "condition", "tests", null, "UNSATISFIED", { round: 1, evidence: "deterministic", required: true, snapshot: "S1", detail: "x" });
      t.event(RUN, "condition", "w", null, "WAIVED", { round: 1, evidence: "deterministic", required: true, snapshot: "S2", detail: "waived" });
      t.event(RUN, "condition_round", "1", null, "UNSATISFIED", { snapshot: "S1" });
      t.event(RUN, "workflow", "wf-1", "RUNNING", "DONE", {});
    });
    assert.deepEqual(checkWorkflowDone(env.journal, w).map((v) => `${v.where}:${v.code}`), ["tests:REQUIRED_CONDITION_UNMET"]);
    assert.deepEqual(checkSameSnapshot(env.journal).map((v) => `${v.where}:${v.code}`), ["w:MIXED_SNAPSHOTS"]);
    const stripped: Workflow = { ...w, conditions: w.conditions.map((c) => (c.id === "w" ? { ...c, waivedBy: undefined } : c)) as never };
    assert.deepEqual(checkWaivers(env.journal, stripped).map((v) => v.code), ["WAIVER_WITHOUT_ACTOR"]);
    assert.deepEqual(checkWaivers(env.journal, w), []);
  });
});
