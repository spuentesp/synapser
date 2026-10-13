// The demo, for real: Nemotron agents (and optionally a Nemotron supervisor) run the discount
// mission through scheduler → loop → executor → Zoanthrope → LocalRunner, judged by unit tests
// AND the independent oracle. `npm run test:live`. Spends cents.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Executor } from "../../src/executor/executor.ts";
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../../src/journal/lock.ts";
import { BILLING_CONTRACT, BILLING_OBJECTIVE, billingAcceptance, billingPlan } from "../../src/mission/billing-fixture.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import { planMission } from "../../src/mission/supervisor.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../../src/model/index.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { ZooAdapter } from "../../src/zoo/adapter.ts";
import { loadPin } from "../../src/zoo/pin.ts";

const KEY = process.env["NEBIUS_API_KEY"] ?? process.env["NEBIUS_TOKEN"] ?? process.env["NEMOTRON_TOKEN"];
const skip = KEY ? false : "no NEBIUS_API_KEY / NEBIUS_TOKEN / NEMOTRON_TOKEN in the environment";
const FX = resolve("fixtures/billing");

async function mission(label: string, planner: "fixed" | "supervisor") {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "live-m-ws-")));
  cpSync(join(FX, "baseline"), ws, { recursive: true });
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "live-m-state-")));
  const runId = `live-${label}`;
  const lock = acquireWorkspaceLock(stateDir, ws);
  const journal = Journal.open(stateDir, runId);
  const zoo = await ZooAdapter.open(loadPin(), ws);
  const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) });
  const executor = new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation });
  const budget = new BudgetManager({ maxTokens: 600_000, maxCalls: 120 });
  const t0 = Date.now();
  try {
    let plan: Plan;
    let planAttempts = 0;
    if (planner === "supervisor") {
      const p = await planMission(model, { runId, objective: BILLING_OBJECTIVE, contract: BILLING_CONTRACT, workspaceRoot: ws, maxTasks: 5 }, { budget });
      plan = p.plan;
      planAttempts = p.attempts;
    } else {
      plan = billingPlan();
    }
    const validation = new LocalRunner({ journal, runId, workspaceRoot: ws, commands: billingAcceptance(FX), generation: lock.generation });
    const r = await runMission(
      { executor, journal, model, validation, budget },
      { runId, objective: BILLING_OBJECTIVE, plan, acceptance: ["unit", "oracle"], limits: { concurrency: 3, maxRepairRounds: 1, missionMs: 8 * 60_000, loop: { maxSteps: 25, maxTokensPerCall: 6000 } } },
    );
    const calls = journal.listModelCalls();
    const byRole: Record<string, { n: number; tok: number; usd: number }> = {};
    for (const c of calls) {
      const e = (byRole[c.role] ??= { n: 0, tok: 0, usd: 0 });
      e.n++;
      e.tok += (c.promptTokens ?? 0) + (c.completionTokens ?? 0);
      e.usd += c.costUsd ?? 0;
    }
    const steps = journal.listEvents().filter((e) => e.entity === "agent_step");
    const rejected = steps.filter((e) => e.toState === "REJECTED").map((e) => `${e.entityId}:${(e.data as { detail?: string }).detail}`);
    const waits = journal.listEvents().filter((e) => e.entity === "action" && e.toState === "WAITING_RESOURCE").length;
    const stale = journal.listEvents().filter((e) => e.entity === "action" && (e.data as { error_code?: string }).error_code === "STALE_VIEW").length;
    console.log(
      `\n=== ${label} (${planner}) ===\nstatus=${r.status} reason=${r.reason ?? "-"} repairRounds=${r.repairRounds} wall=${((Date.now() - t0) / 1000).toFixed(1)}s planAttempts=${planAttempts}\n` +
        `tasks: ${r.tasks.map((t) => `${t.taskId}=${t.state}`).join(" ")}\n` +
        `plan: ${plan.tasks.map((t) => `${t.id}[${t.scope.join("+")}]<-${t.deps.join(",") || "-"}`).join("  ")}\n` +
        `model: ${Object.entries(byRole).map(([k, v]) => `${k}: ${v.n} calls ${v.tok} tok $${v.usd.toFixed(4)}`).join(" | ")}\n` +
        `coordination: waits=${waits} staleViews=${stale} rejectedToolCalls=${rejected.length}${rejected.length ? ` (${rejected.slice(0, 6).join(", ")})` : ""}\n` +
        `validations: ${r.validations.map((v) => `${v.taskId}/${v.commandId}=${v.passed ? "PASS" : "FAIL"}${v.networkIsolated ? "" : "(no-netns)"}`).join(" ")}`,
    );
    return { r, ws, zoo, plan };
  } finally {
    await zoo.close();
    journal.close();
    lock.release();
  }
}

test("fixed plan, real Nemotron agents (3 concurrent), acceptance by unit tests + oracle", { skip, timeout: 600_000 }, async () => {
  const { r } = await mission("fixed", "fixed");
  assert.equal(r.status, "DONE", `mission ${r.status}: ${r.reason}`);
});

test("supervisor-planned: Nemotron decomposes the mission, agents execute it, acceptance decides", { skip, timeout: 600_000 }, async () => {
  const { r, plan } = await mission("planned", "supervisor");
  assert.ok(plan.tasks.length >= 2, "a real decomposition");
  assert.equal(r.status, "DONE", `mission ${r.status}: ${r.reason}`);
});
