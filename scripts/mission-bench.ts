// Mission benchmark: run the discount mission N times per worker model and report the outcome
// distribution, cost and failure modes. This is the data behind any "it works" claim.
//   node --env-file=.env scripts/mission-bench.ts --runs 3 --workers nvidia/Nemotron-3_5-Lightning,nvidia/nemotron-3-super-120b-a12b
//   options: --plan fixed|supervisor  --concurrency 3  --repair 1  --supervisor <model>
//            --arm synapser|naive|both   (docs/plans/09: same loop, same prompts; only the WriteGateway differs)

import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAcceptance, checkChain, checkGrantBeforeWrite, checkLineage, digestOnDisk, executorTrace, type Violation, type WriteRecord } from "../src/audit/invariants.ts";
import { NaiveGateway } from "../src/bench/naive-gateway.ts";
import type { DigestOrAbsent } from "../src/digest/file.ts";
import { Executor } from "../src/executor/executor.ts";
import type { WriteGateway } from "../src/executor/gateway.ts";
import { readdirSync, statSync } from "node:fs";
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
const ARM = arg("arm", "synapser") as "synapser" | "naive" | "both";
const ARMS = ARM === "both" ? (["naive", "synapser"] as const) : ([ARM] as const);
const FX = resolve("fixtures/billing");

const walk = (root: string, dir = ""): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const rel = dir ? `${dir}/${n}` : n;
    return statSync(join(root, rel)).isDirectory() ? (n === "__pycache__" || n.startsWith(".") ? [] : walk(root, rel)) : [rel];
  });

interface Row {
  arm: string;
  violations: Record<string, number>;
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
  for (const arm of ARMS) {
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
    const initial = new Map<string, DigestOrAbsent>(walk(ws).map((p) => [p, digestOnDisk(ws, p) as DigestOrAbsent]));
    let hook: ReturnType<typeof executorTrace>["hook"] | null = null;
    const exTrace = executorTrace(journal, ws);
    hook = exTrace.hook;
    const naive = new NaiveGateway({ workspace: ws, runId });
    const executor: WriteGateway =
      arm === "naive" ? naive : new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation, beforeRename: (i) => hook?.(i) });
    const traceOf = (): WriteRecord[] => (arm === "naive" ? naive.trace : exTrace.trace);
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
      // new files are absent in `initial`; checkLineage treats a missing entry as ABSENT
      const viol: Violation[] = [...checkLineage(traceOf(), initial), ...checkGrantBeforeWrite(journal), ...checkAcceptance(journal), ...checkChain(journal)];
      const violations: Record<string, number> = {};
      for (const v of viol) violations[`${v.invariant}:${v.code}`] = (violations[`${v.invariant}:${v.code}`] ?? 0) + 1;
      row = {
        arm,
        violations,
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
      row = { arm, violations: {}, worker, run, status: "ERROR", reason: String((e as Error).message).slice(0, 120), repair: 0, wallS: (Date.now() - t0) / 1000, calls: 0, tokens: 0, usd: 0, rejected: {}, tasks: "", failure: null };
    } finally {
      await zoo.close();
      journal.close();
      lock.release();
    }
    rows.push(row);
    console.log(`[${arm}] ${worker.split("/").pop()} #${run}: violations=${JSON.stringify(row.violations)} ${row.status}${row.reason ? ` (${row.reason})` : ""} repair=${row.repair} ${row.wallS}s ${row.calls} calls ${row.tokens} tok $${row.usd.toFixed(4)} rejected=${JSON.stringify(row.rejected)}${row.failure ? `\n      why: ${row.failure}` : ""}`);
  }
  }
}

console.log("\n== summary ==");
for (const w of WORKERS) {
  for (const a of ARMS) {
    const mine = rows.filter((r) => r.worker === w && r.arm === a);
    if (mine.length === 0) continue;
    const done = mine.filter((r) => r.status === "DONE").length;
    const first = mine.filter((r) => r.status === "DONE" && r.repair === 0).length;
    const lost = mine.reduce((n, r) => n + (r.violations["I1:LOST_UPDATE"] ?? 0), 0);
    const withLoss = mine.filter((r) => (r.violations["I1:LOST_UPDATE"] ?? 0) > 0).length;
    const other = mine.reduce((n, r) => n + Object.entries(r.violations).filter(([k]) => k !== "I1:LOST_UPDATE").reduce((m, [, v]) => m + v, 0), 0);
    const avg = (f: (r: Row) => number) => mine.reduce((x, r) => x + f(r), 0) / mine.length;
    console.log(`[${a}] ${w}: DONE ${done}/${mine.length} (no repair ${first}) | I1 lost updates ${lost} in ${withLoss}/${mine.length} runs | other violations ${other} | avg ${avg((r) => r.wallS).toFixed(1)}s ${Math.round(avg((r) => r.tokens))} tok $${avg((r) => r.usd).toFixed(4)}`);
  }
}
mkdirSync("evidence", { recursive: true });
writeFileSync(`evidence/mission-bench-${ARM}.json`, JSON.stringify({ at: new Date().toISOString(), arm: ARM, plan: PLAN, concurrency: CONC, rows }, null, 2) + "\n");
