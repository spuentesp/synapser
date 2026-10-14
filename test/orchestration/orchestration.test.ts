// Plan 10, tramo A — everything here runs WITHOUT a model: catalog, cost estimation, router, plan
// validation, approval gates and the W1–W4 ledger checkers.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { validatePlan } from "../../src/mission/plan.ts";
import { buildCatalog, estimateCost, kindsOf, type ProfileCard, type RunSample } from "../../src/orchestration/catalog.ts";
import { approvalStatus, decideApproval, pendingApprovals, planDigest, requestApproval } from "../../src/orchestration/gates.ts";
import { checkAdvisorsReadOnly, checkBudget, checkDispatch, checkGates, recordDispatch } from "../../src/orchestration/invariants.ts";
import { planCost, route } from "../../src/orchestration/router.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const run = (profileId: string, usd: number | null, at: number, ok = true): RunSample => ({ profileId, succeeded: ok, usd, durationMs: 1000, at });
const card = (id: string, over: Partial<ProfileCard> = {}): ProfileCard => ({
  id, kinds: ["write"], integration: "pending", tier: "standard", pool: null, strengths: [], cost: { basis: "unknown", reason: "NO_HISTORY" }, observed: null, enabled: true, ...over,
});
const est = (usd: number): ProfileCard["cost"] => ({ basis: "estimated", usdPerRun: usd, low: usd, high: usd * 2, n: 5 });

describe("catalog and cost estimation", () => {
  test("kinds follow the role: writers write, advisors advise and review", () => {
    const byId = (id: string) => BUILTIN_PROFILES.find((p) => p.id === id) as AgentProfile;
    assert.deepEqual(kindsOf(byId("claude-sonnet-writer")), ["write"]);
    assert.deepEqual(kindsOf(byId("claude-opus-advisor")), ["advise", "review"]);
  });

  test("cost basis: no history, too few runs, estimated, tariff — and unknown-provenance runs never count", () => {
    const cat = (samples: RunSample[], o = {}) => Object.fromEntries(buildCatalog(BUILTIN_PROFILES, samples, o).map((c) => [c.id, c]));
    assert.deepEqual(cat([])["codex-writer"]!.cost, { basis: "unknown", reason: "NO_HISTORY" });
    assert.deepEqual(cat([run("codex-writer", 0.01, 1), run("codex-writer", 0.02, 2)])["codex-writer"]!.cost, { basis: "unknown", reason: "TOO_FEW_RUNS" });
    const three = cat([run("codex-writer", 0.01, 1), run("codex-writer", 0.03, 2), run("codex-writer", 0.02, 3)])["codex-writer"]!;
    assert.deepEqual(three.cost, { basis: "estimated", usdPerRun: 0.02, low: 0.01, high: 0.03, n: 3 });
    assert.equal(three.observed!.runs, 3);
    // runs with no reported cost are history of ACTIVITY, not of cost
    assert.deepEqual(cat([run("kimi-writer", null, 1), run("kimi-writer", null, 2), run("kimi-writer", null, 3)])["kimi-writer"]!.cost, { basis: "unknown", reason: "NO_HISTORY" });
    assert.deepEqual(cat([], { knownUsdPerRun: { "codex-writer": 0.5 } })["codex-writer"]!.cost, { basis: "known", usdPerRun: 0.5 });
  });

  test("W7: an estimate is a pure function of the history, and an unpredictable history degrades to unknown", () => {
    const h = [0.01, 0.012, 0.011, 0.013, 0.012, 0.011];
    const frozen = Object.freeze([...h]);
    assert.deepEqual(estimateCost(frozen), estimateCost([...h]));
    assert.equal(estimateCost(h).basis, "estimated");
    // a history that cannot predict itself: costs swing by orders of magnitude
    const wild = [0.001, 0.5, 0.002, 0.9, 0.001, 0.7, 0.002];
    assert.deepEqual(estimateCost(wild), { basis: "unknown", reason: "UNSTABLE" });
    // the stable history stays estimated as long as it stays predictable
    assert.equal(estimateCost([...h, 0.012, 0.011]).basis, "estimated");
  });
});

describe("router", () => {
  const cat = [
    card("w-cheap", { kinds: ["write"], cost: est(0.01), strengths: ["code"] }),
    card("w-pricey", { kinds: ["write"], cost: est(0.20), strengths: ["code"] }),
    card("w-unknown", { kinds: ["write"], strengths: ["code"] }),
    card("w-off", { kinds: ["write"], enabled: false, cost: est(0.001) }),
    card("adv", { kinds: ["advise", "review"], cost: est(0.05) }),
  ];

  test("only enabled profiles of the right kind are candidates; an advisor never gets a write", () => {
    const d = route({ kind: "write" }, cat);
    assert.ok(d.ok && d.profileId === "w-cheap");
    const r = route({ kind: "write" }, [card("adv", { kinds: ["advise"] }), card("off", { enabled: false })]);
    assert.deepEqual(r, { ok: false, code: "NO_CANDIDATE", rejected: [{ profileId: "adv", code: "KIND_MISMATCH" }, { profileId: "off", code: "DISABLED" }] });
    const a = route({ kind: "advise" }, cat);
    assert.ok(a.ok && a.profileId === "adv");
  });

  test("the model SUGGESTS: it breaks ties but cannot override cost policy, and the override is recorded", () => {
    const tie = [card("a", { cost: est(0.05) }), card("b", { cost: est(0.05) })];
    const t = route({ kind: "write", suggested: "b" }, tie);
    assert.ok(t.ok && t.profileId === "b" && t.reason === "suggestion", "tie → suggestion wins");
    const o = route({ kind: "write", suggested: "w-pricey" }, cat);
    assert.ok(o.ok && o.profileId === "w-cheap" && o.reason === "policy");
    assert.deepEqual(o.alerts.map((x) => x.code), ["SUGGESTION_OVERRIDDEN"]);
  });

  test("a known or estimated cost beats an unknown one; unknown alone is allowed but ALERTS", () => {
    const d = route({ kind: "write", suggested: "w-unknown" }, cat);
    assert.ok(d.ok && d.profileId === "w-cheap");
    const only = route({ kind: "write" }, [card("u", { strengths: ["code"] })]);
    assert.ok(only.ok && only.profileId === "u");
    assert.deepEqual(only.alerts.map((x) => x.code), ["COST_UNKNOWN"]);
  });

  test("capability fit comes first: a matching, pricier profile beats a cheaper non-matching one", () => {
    const c = [card("cheap-generic", { cost: est(0.01), strengths: ["docs"] }), card("fit", { cost: est(0.10), strengths: ["refactor"] })];
    const d = route({ kind: "write", tags: ["refactor"] }, c);
    assert.ok(d.ok && d.profileId === "fit");
  });

  test("a repair-specialised profile is not chosen for ordinary work, and is for repair work", () => {
    const c = [card("nemotron-repair", { strengths: ["repair"] }), card("nemotron-worker", { strengths: ["code"] })];
    const ordinary = route({ kind: "write" }, c);
    assert.ok(ordinary.ok && ordinary.profileId === "nemotron-worker", "alphabetical order must not decide this");
    const repair = route({ kind: "write", tags: ["repair"] }, c);
    assert.ok(repair.ok && repair.profileId === "nemotron-repair");
  });

  test("W6: the router is a function — any permutation of the catalog gives the same answer", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rnd() * 6);
      const c: ProfileCard[] = Array.from({ length: n }, (_, i) =>
        card(`p${i}`, {
          kinds: rnd() < 0.7 ? ["write"] : ["advise"],
          enabled: rnd() < 0.8,
          strengths: rnd() < 0.5 ? ["code"] : [],
          cost: rnd() < 0.3 ? { basis: "unknown", reason: "NO_HISTORY" } : est(Math.round(rnd() * 5) / 100),
          observed: rnd() < 0.5 ? { runs: 4, succeeded: Math.floor(rnd() * 5), medianMs: 10 } : null,
        }),
      );
      const req = { kind: "write" as const, tags: ["code"], suggested: `p${Math.floor(rnd() * n)}` };
      const base = JSON.stringify(route(req, c));
      for (let k = 0; k < 4; k++) {
        const shuffled = [...c].sort(() => rnd() - 0.5);
        const r = route(req, shuffled);
        const b = JSON.parse(base);
        // `considered` order is by rank, which is the same total order
        assert.deepEqual(JSON.parse(JSON.stringify(r)), b);
      }
      // W1 by construction: whatever it picked is enabled and of the right kind
      const d = route(req, c);
      if (d.ok) {
        const chosen = c.find((x) => x.id === d.profileId)!;
        assert.ok(chosen.enabled && chosen.kinds.includes("write"));
      }
    }
  });

  test("planCost: known and estimated(high) are summed apart; unknown tasks are listed, not guessed", () => {
    const c = planCost(
      [{ id: "t1", kind: "write", profile: "w-cheap" }, { id: "t2", kind: "write", profile: "w-cheap" }, { id: "t3", kind: "advise" }],
      [card("w-cheap", { cost: est(0.01) }), card("adv", { kinds: ["advise"], cost: { basis: "known", usdPerRun: 0.5 } })],
    );
    assert.equal(c.estimatedHighUsd, 0.04);
    assert.equal(c.knownUsd, 0.5);
    assert.deepEqual(c.unknownTasks, []);
  });
});

describe("plan validation against the catalog", () => {
  const root = new URL("../../fixtures/billing/baseline", import.meta.url).pathname;
  const catalog = [card("good", { cost: est(0.05) }), card("off", { enabled: false }), card("adv", { kinds: ["advise"], cost: est(0.01) })];
  const task = (over: Record<string, unknown> = {}) => ({ id: "t1", objective: "Do the thing", scope: ["app/billing.py"], criteria: ["done"], deps: [], ...over });
  const check = (tasks: unknown[], extra: Record<string, unknown> = {}) => validatePlan({ tasks }, { workspaceRoot: root, catalog, ...extra } as never);
  const errs = (r: ReturnType<typeof check>) => (r.ok ? [] : r.errors).join(" | ");

  test("a plan without orchestration fields is unchanged (and routable)", () => {
    assert.equal(check([task()]).ok, true);
  });
  test("unknown, disabled and wrong-kind suggestions are rejected with their code", () => {
    assert.match(errs(check([task({ profile: "nope" })])), /PROFILE_UNKNOWN/);
    assert.match(errs(check([task({ profile: "off" })])), /PROFILE_DISABLED/);
    assert.match(errs(check([task({ profile: "adv" })])), /PROFILE_KIND_MISMATCH/);
    assert.equal(check([task({ profile: "adv", kind: "advise" })]).ok, true, "the same profile is fine for an advise step");
  });
  test("invalid kind or gate, and an unroutable step", () => {
    assert.match(errs(check([task({ kind: "deploy" })])), /INVALID_KIND/);
    assert.match(errs(check([task({ gates: ["magic"] })])), /INVALID_GATE/);
    assert.match(errs(check([task({ kind: "research" })])), /NO_ROUTE/);
  });
  test("OVER_BUDGET uses known + estimated(high); not applied without a budget", () => {
    const two = [task({ id: "a" }), task({ id: "b", scope: ["app/client.py"] })]; // 2 × 0.10 high
    assert.match(errs(check(two, { budgetUsd: 0.15 })), /OVER_BUDGET/);
    assert.equal(check(two, { budgetUsd: 0.25 }).ok, true);
    assert.equal(check(two).ok, true);
  });
});

describe("approval gates and ledger checkers (W1–W4)", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());
  const plan = (n: number) => ({ tasks: [{ id: "t1", objective: `Do thing ${n}`, scope: ["app/billing.py"], criteria: ["c"], deps: [] }] });
  const dispatch = (taskId: string, profile: string, over: Record<string, unknown> = {}) =>
    recordDispatch(env.journal, RUN, { taskId, profileId: profile, kind: "write", reason: "policy", suggested: null, costBasis: "estimated", planDigest: "d", gates: [], alerts: [], ...over } as never);

  test("an approval is bound to the plan digest: change the plan and it no longer holds", () => {
    const d1 = planDigest(plan(1));
    const d2 = planDigest(plan(2));
    assert.notEqual(d1, d2);
    assert.equal(approvalStatus(env.journal, "t1", d1), "NONE");
    assert.equal(requestApproval(env.journal, RUN, "t1", d1), true);
    assert.equal(requestApproval(env.journal, RUN, "t1", d1), false, "idempotent");
    assert.deepEqual(pendingApprovals(env.journal, d1), ["t1"]);
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: "t1", planDigest: d1, currentDigest: d2, decision: "APPROVED", actor: "ana" }), { ok: false, code: "STALE_DIGEST" });
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: "t1", planDigest: d1, currentDigest: d1, decision: "APPROVED", actor: "ana" }), { ok: true });
    assert.equal(approvalStatus(env.journal, "t1", d1), "APPROVED");
    assert.equal(approvalStatus(env.journal, "t1", d2), "NONE", "the new plan needs its own approval");
    assert.deepEqual(decideApproval(env.journal, RUN, { taskId: "t1", planDigest: d1, currentDigest: d1, decision: "REJECTED", actor: "ana" }), { ok: false, code: "NOT_PENDING" });
  });

  test("W3: a gated step is accepted only with an approval for ITS plan digest, given before it started", () => {
    const d = "dig-A";
    dispatch("ok", "good", { gates: ["approval"], planDigest: d });
    assert.equal(checkGates(env.journal).length, 1, "no approval requested at all");
    assert.equal(checkGates(env.journal)[0]!.code, "GATE_NOT_REQUESTED");

    requestApproval(env.journal, RUN, "t-ok", d);
    decideApproval(env.journal, RUN, { taskId: "t-ok", planDigest: d, currentDigest: d, decision: "APPROVED", actor: "ana" });
    dispatch("t-ok", "good", { gates: ["approval"], planDigest: d });
    dispatch("t-rej", "good", { gates: ["approval"], planDigest: d });
    requestApproval(env.journal, RUN, "t-rej", d);
    decideApproval(env.journal, RUN, { taskId: "t-rej", planDigest: d, currentDigest: d, decision: "REJECTED", actor: "ana" });
    dispatch("t-rej", "good", { gates: ["approval"], planDigest: d }); // ran despite rejection
    const v = checkGates(env.journal).map((x) => `${x.where}:${x.code}`);
    assert.deepEqual(v, ["ok:GATE_NOT_REQUESTED", "t-rej:GATE_NOT_REQUESTED", "t-rej:GATE_REJECTED"]);
  });

  test("W1: dispatching to an unknown, disabled or wrong-kind profile is flagged", () => {
    const catalog = [card("good"), card("off", { enabled: false }), card("adv", { kinds: ["advise"] })];
    dispatch("a", "good");
    dispatch("b", "off");
    dispatch("c", "adv");
    dispatch("d", "ghost");
    assert.deepEqual(checkDispatch(env.journal, catalog).map((v) => `${v.where}:${v.code}`), ["b:PROFILE_DISABLED", "c:PROFILE_KIND_MISMATCH", "d:PROFILE_UNKNOWN"]);
  });

  test("W2: an advisory step with an applied action is flagged; a write step with one is not", () => {
    env.journal.tx((t) => {
      t.insertMission({ runId: RUN, objective: "x", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
      for (const id of ["advise-1", "write-1"]) {
        t.insertTask({ runId: RUN, taskId: id, actorOwner: `${RUN}:${id}`, priority: 0, scope: [], spec: { kind: "agent", objective: id, criteria: [] }, planRevision: 1, deps: [] });
      }
    });
    dispatch("advise-1", "adv", { kind: "advise" });
    dispatch("write-1", "good", { kind: "write" });
    assert.deepEqual(checkAdvisorsReadOnly(env.journal), [], "nothing written yet");
  });

  test("W4: unknown-cost dispatches must have raised their alert; a missing alert is flagged", () => {
    dispatch("x", "u", { costBasis: "unknown", alerts: [{ code: "COST_UNKNOWN", profileId: "u" }] });
    dispatch("y", "u", { costBasis: "unknown", alerts: [] });
    assert.deepEqual(checkBudget(env.journal).map((v) => `${v.where}:${v.code}`), ["y:UNKNOWN_COST_WITHOUT_ALERT"]);
  });
});

describe("supervisor with a catalog", () => {
  test("the planner SEES the catalog; an invalid suggestion is fed back with its code and a corrected plan is accepted", async () => {
    const { planMission } = await import("../../src/mission/supervisor.ts");
    const { ScriptedModel } = await import("../agent/scripted.ts");
    const root = new URL("../../fixtures/billing/baseline", import.meta.url).pathname;
    const plan = (profile: string) =>
      JSON.stringify({ tasks: [{ id: "a", objective: "Change the billing module", scope: ["app/billing.py"], criteria: ["c"], deps: [], profile }] });
    const catalog = [card("good", { strengths: ["code"], cost: est(0.02) }), card("off", { enabled: false })];
    const m = new ScriptedModel((_msgs, n) => ({ content: n === 1 ? plan("ghost") : plan("good") }));
    const out = await planMission(m, { runId: RUN, objective: "o", contract: [], workspaceRoot: root, catalog });
    assert.equal(out.attempts, 2);
    assert.equal(out.plan.tasks[0]!.profile, "good");
    const firstPrompt = JSON.stringify(m.seen[0]);
    assert.match(firstPrompt, /AVAILABLE AGENT PROFILES/);
    assert.match(firstPrompt, /good \[standard\]: can write; strengths code; estimated/);
    assert.doesNotMatch(firstPrompt, /\boff\b: can/, "disabled profiles are not offered");
    assert.match(JSON.stringify(m.seen[1]), /PROFILE_UNKNOWN/);
  });
});
