// Mission benchmark: run the discount mission N times per worker model and report the outcome
// distribution, cost and failure modes. This is the data behind any "it works" claim.
//   node --env-file=.env scripts/mission-bench.ts --runs 3 --workers nvidia/Nemotron-3_5-Lightning,nvidia/nemotron-3-super-120b-a12b
//   options: --plan fixed|supervisor  --concurrency 3  --repair 1  --supervisor <model>

import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Executor } from "../src/executor/executor.ts";
import { Journal } from "../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../src/journal/lock.ts";
import { BILLING_CONTRACT, BILLING_OBJECTIVE, billingAcceptance, billingPlan } from "../src/mission/billing-fixture.ts";
import { runMission } from "../src/mission/runner.ts";
import { planMission } from "../src/mission/supervisor.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../src/model/index.ts";
import { LocalRunner } from "../src/validation/runner.ts";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] as string) : d;
};
const RUNS = Number(arg("runs", "3"));
const WORKERS = arg("workers", "nvidia/Nemotron-3_5-Lightning").split(",");
const PLAN = arg("plan", "fixed") as "fixed" | "supervisor";
const CONC = Number(arg("concurrency", "3"));
const REPAIR = Number(arg("repair", "1"));
const FX = resolve("fixtures/billing");

interface Row {
  worker: string;
  run: number;
  status: string;
  reason: string | null;
  repair: number;
  wallS: number;
  calls: number;
  tokens: number;
  usd: number;
  rejected: Record<string, number>;
  tasks: string;
  /** Tail of the first failing acceptance output, so a FAILED row explains itself. */
  failure: string | null;
}
const rows: Row[] = [];

for (const worker of WORKERS) {
  for (let run = 1; run <= RUNS; run++) {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "bench-ws-")));
    cpSync(join(FX, "baseline"), ws, { recursive: true });
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "bench-state-")));
    const runId = `bench-${Date.now()}-${run}`;
    const lock = acquireWorkspaceLock(stateDir, ws);
    const journal = Journal.open(stateDir, runId);
    const zoo = await ZooAdapter.open(loadPin(), ws);
    const cfg = defaultModelConfig();
    cfg.roles.worker = { ...cfg.roles.worker, model: worker, fallbacks: [] };
    cfg.roles.repair = { ...cfg.roles.repair, model: worker, fallbacks: [] };
    if (arg("supervisor", "")) cfg.roles.supervisor = { ...cfg.roles.supervisor, model: arg("supervisor", "") };
    const model = new OpenAICompatibleProvider({ config: cfg, onCall: journalRecorder(journal) });
    const executor = new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation });
    const budget = new BudgetManager({ maxTokens: 800_000, maxCalls: 150 });
    const t0 = Date.now();
    let row: Row;
    try {
      const plan = PLAN === "supervisor" ? (await planMission(model, { runId, objective: BILLING_OBJECTIVE, contract: BILLING_CONTRACT, workspaceRoot: ws, maxTasks: 5 }, { budget })).plan : billingPlan();
      const validation = new LocalRunner({ journal, runId, workspaceRoot: ws, commands: billingAcceptance(FX), generation: lock.generation });
      const r = await runMission(
        { executor, journal, model, validation, budget },
        { runId, objective: BILLING_OBJECTIVE, plan, acceptance: ["unit", "oracle"], limits: { concurrency: CONC, maxRepairRounds: REPAIR, missionMs: 8 * 60_000, loop: { maxSteps: 25, maxTokensPerCall: 6000 } } },
      );
      const calls = journal.listModelCalls();
      const rejected: Record<string, number> = {};
      for (const e of journal.listEvents().filter((e) => e.entity === "agent_step" && e.toState === "REJECTED")) {
        const d = String((e.data as { detail?: string }).detail ?? "?").replace(/\$\.\w+: /, "").slice(0, 40);
        rejected[d] = (rejected[d] ?? 0) + 1;
      }
      row = {
        worker,
        run,
        status: r.status,
        reason: r.reason,
        repair: r.repairRounds,
        wallS: Math.round((Date.now() - t0) / 100) / 10,
        calls: calls.length,
        tokens: calls.reduce((a, c) => a + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0),
        usd: calls.reduce((a, c) => a + (c.costUsd ?? 0), 0),
        rejected,
        tasks: r.tasks.map((t) => `${t.taskId}=${t.state}`).join(" "),
        failure: (() => {
          const bad = journal.listValidations().filter((v) => v.exitCode !== 0 && v.outputBlob).at(-1);
          if (!bad || r.status === "DONE") return null;
          const o = JSON.parse(journal.artifacts.get(bad.outputBlob!).toString()) as { stdout: string; stderr: string };
          return `${bad.command}: ${(o.stderr + o.stdout).trim().split("\n").slice(-6).join(" | ").slice(0, 500)}`;
        })(),
      };
    } catch (e) {
      row = { worker, run, status: "ERROR", reason: String((e as Error).message).slice(0, 120), repair: 0, wallS: (Date.now() - t0) / 1000, calls: 0, tokens: 0, usd: 0, rejected: {}, tasks: "", failure: null };
    } finally {
      await zoo.close();
      journal.close();
      lock.release();
    }
    rows.push(row);
    console.log(`${worker.split("/").pop()} #${run}: ${row.status}${row.reason ? ` (${row.reason})` : ""} repair=${row.repair} ${row.wallS}s ${row.calls} calls ${row.tokens} tok $${row.usd.toFixed(4)} rejected=${JSON.stringify(row.rejected)}${row.failure ? `\n      why: ${row.failure}` : ""}`);
  }
}

console.log("\n== summary ==");
for (const w of WORKERS) {
  const mine = rows.filter((r) => r.worker === w);
  const done = mine.filter((r) => r.status === "DONE").length;
  const first = mine.filter((r) => r.status === "DONE" && r.repair === 0).length;
  console.log(`${w}: DONE ${done}/${mine.length} (without repair ${first}) avg ${(mine.reduce((a, r) => a + r.wallS, 0) / mine.length).toFixed(1)}s avg $${(mine.reduce((a, r) => a + r.usd, 0) / mine.length).toFixed(4)}`);
}
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/mission-bench.json", JSON.stringify({ at: new Date().toISOString(), plan: PLAN, concurrency: CONC, rows }, null, 2) + "\n");
