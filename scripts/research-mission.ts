// Live research-required mission: Nemotron plans nothing here (fixed plan), uses Tavily for real, and
// is accepted only by the oracle AND citation provenance.
//   node --env-file=.env scripts/research-mission.ts [--runs 1]
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Executor } from "../src/executor/executor.ts";
import { Journal } from "../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../src/journal/lock.ts";
import { citationCheck, CURRENCY_OBJECTIVE, currencyAcceptance, currencyPlan } from "../src/mission/currency-fixture.ts";
import { runMission } from "../src/mission/runner.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../src/model/index.ts";
import { QueryGuard, researchFromEnv, ResearchSession } from "../src/research/index.ts";
import { LocalRunner } from "../src/validation/runner.ts";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";

const i = process.argv.indexOf("--runs");
const RUNS = i >= 0 ? Number(process.argv[i + 1]) : 1;
const FX = resolve("fixtures/currency");

for (let n = 1; n <= RUNS; n++) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "res-ws-")));
  cpSync(join(FX, "baseline"), ws, { recursive: true });
  const st = realpathSync(mkdtempSync(join(tmpdir(), "res-st-")));
  const runId = `research-${Date.now()}-${n}`;
  const lock = acquireWorkspaceLock(st, ws);
  const journal = Journal.open(st, runId);
  const zoo = await ZooAdapter.open(loadPin(), ws);
  const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) });
  const executor = new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation });
  const research = new ResearchSession({ port: researchFromEnv(), journal, runId, guard: new QueryGuard(ws) });
  const t0 = Date.now();
  try {
    const r = await runMission(
      {
        executor,
        journal,
        model,
        research,
        budget: new BudgetManager({ maxTokens: 400_000, maxCalls: 80 }),
        validation: new LocalRunner({ journal, runId, workspaceRoot: ws, commands: currencyAcceptance(FX), generation: lock.generation }),
        extraChecks: [citationCheck(journal, ws)],
      },
      { runId, objective: CURRENCY_OBJECTIVE, plan: currencyPlan(), acceptance: ["oracle"], limits: { concurrency: 2, maxRepairRounds: 1, missionMs: 5 * 60_000 } },
    );
    const rc = journal.listResearchCalls();
    const usd = journal.listModelCalls().reduce((a, c) => a + (c.costUsd ?? 0), 0);
    console.log(`#${n}: ${r.status}${r.reason ? ` (${r.reason})` : ""} ${((Date.now() - t0) / 1000).toFixed(1)}s repair=${r.repairRounds} searches=${rc.length} credits=${rc.reduce((a, c) => a + (c.creditsUsed ?? 0), 0)} model $${usd.toFixed(4)}`);
    for (const c of rc) console.log(`   search ${c.error ? "ERR " + c.error : "ok"} urls=${c.urls.length}: ${c.query ?? "(refused)"}`);
    for (const e of journal.listEvents().filter((e) => e.entity === "acceptance_check")) console.log(`   check ${(e.data as { check: string }).check}: ${e.toState} ${(e.data as { detail: string }).detail}`);
  } finally {
    await zoo.close();
    journal.close();
    lock.release();
  }
}
