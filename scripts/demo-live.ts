// The demo with REAL models: Nemotron plans the mission (seeing the agent catalog), Nemotron workers
// implement it on the real executor/journal/Zoanthrope, a real CLI advisor reviews the result, Tavily is
// available to the workers, a human approves the gated step in the UI, and the ledger is auditable.
//   node --env-file=.env scripts/demo-live.ts [--port 4173] [--advisor codex-advisor|claude-opus-advisor|none]
//        [--approve-after SECONDS] [--history <stateDir>:<runId>]
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../src/api/server.ts";
import { CliOneShotRunner, NativeLoopRunner } from "../src/agents/adapters.ts";
import { AgentRunnerRegistry } from "../src/agents/port.ts";
import { type AgentProfile, BUILTIN_PROFILES } from "../src/agents/profile.ts";
import { Executor } from "../src/executor/executor.ts";
import { Journal } from "../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../src/journal/lock.ts";
import { BILLING_CONTRACT, BILLING_OBJECTIVE, billingAcceptance } from "../src/mission/billing-fixture.ts";
import type { Plan } from "../src/mission/plan.ts";
import { runMission } from "../src/mission/runner.ts";
import { planMission } from "../src/mission/supervisor.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../src/model/index.ts";
import { buildCatalog, samplesFromJournal } from "../src/orchestration/catalog.ts";
import { QueryGuard, researchFromEnv, ResearchSession } from "../src/research/index.ts";
import { LocalRunner } from "../src/validation/runner.ts";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { ZooCollector } from "../src/zoo/collector.ts";
import { zooIntentSink } from "../src/zoo/intent.ts";
import { loadPin } from "../src/zoo/pin.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] as string) : d;
};
const PORT = Number(arg("port", "4173"));
const APPROVE_AFTER = Number(arg("approve-after", "0"));
const ADVISOR_ID = arg("advisor", "codex-advisor");
const HISTORY = arg("history", "");
const FX = resolve("fixtures/billing");

const ws = realpathSync(mkdtempSync(join(tmpdir(), "live-ws-")));
cpSync(join(FX, "baseline"), ws, { recursive: true });
const state = realpathSync(mkdtempSync(join(tmpdir(), "live-state-")));
const runId = `live-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const lock = acquireWorkspaceLock(state, ws);
const journal = Journal.open(state, runId);
const zoo = await ZooAdapter.open(loadPin(), ws);
const executor = new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation });
const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) });
const budget = new BudgetManager({ maxTokens: 700_000, maxCalls: 150 });
const research = new ResearchSession({ port: researchFromEnv(), journal, runId, guard: new QueryGuard(ws) });

// ---- the toolbox: what exists, and what each profile has ACTUALLY cost before (learned, not declared)
const advisor = ADVISOR_ID === "none" ? null : (BUILTIN_PROFILES.find((p) => p.id === ADVISOR_ID) as AgentProfile | undefined) ?? null;
if (ADVISOR_ID !== "none" && !advisor) throw new Error(`unknown advisor profile ${ADVISOR_ID}`);
const PROFILES = [BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!, BUILTIN_PROFILES.find((p) => p.id === "nemotron-repair")!, ...(advisor ? [advisor] : [])];
let samples: ReturnType<typeof samplesFromJournal> = [];
if (HISTORY) {
  const [dir, id] = HISTORY.split(":");
  const h = Journal.open(dir as string, id as string);
  samples = samplesFromJournal(h);
  h.close();
}
const catalog = buildCatalog(PROFILES, samples);

// ---- the plan: Nemotron decomposes the mission seeing the catalog; the router assigns profiles
console.log(`planning with ${catalog.filter((c) => c.enabled).map((c) => `${c.id}[${c.cost.basis}]`).join(", ")} …`);
const planned = await planMission(model, { runId, objective: BILLING_OBJECTIVE, contract: BILLING_CONTRACT, workspaceRoot: ws, maxTasks: 5, catalog }, { budget });
const plan: Plan = { tasks: [...planned.plan.tasks] };
const ids = new Set(plan.tasks.map((t) => t.id));
if (advisor && !ids.has("review")) {
  plan.tasks.push({
    id: "review", objective: "Review the combined change for mismatches with the contract and list concrete findings", scope: ["app/", "tests/"],
    criteria: ["a list of findings, or an explicit statement that there are none"], deps: plan.tasks.map((t) => t.id), kind: "advise", profile: advisor.id,
  });
}
// a human decision point: whichever step touches the README waits for an approval in the UI
const readme = plan.tasks.find((t) => t.scope.includes("README.md"));
if (readme) readme.gates = ["approval"];
if (!readme && !ids.has("docs")) {
  plan.tasks.push({
    id: "docs", objective: "Document the discount parameter of checkout() in the README", scope: ["README.md"], criteria: ["README documents discount_bps"],
    deps: advisor ? ["review"] : plan.tasks.map((t) => t.id), gates: ["approval"], tags: ["code"],
  });
}
console.log(`plan (${planned.attempts} attempt${planned.attempts > 1 ? "s" : ""}): ${plan.tasks.map((t) => `${t.id}${t.kind ? `:${t.kind}` : ""}`).join(", ")}`);

const api = createApi({ stateDir: state, journals: new Map([[runId, journal]]) });
const port = await api.listen(PORT);
console.log(`\n  Synapser UI  →  http://127.0.0.1:${port}/#swarm\n  run: ${runId}   state: ${state}\n  next time: --history ${state}:${runId}\n`);
if (APPROVE_AFTER > 0) {
  setTimeout(async () => {
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/state`)).json()) as { planDigest: string; pendingApprovals: string[] };
    for (const task of st.pendingApprovals) {
      await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/approvals/${task}`, {
        method: "POST", headers: { "content-type": "application/json", "x-synapser-token": api.token },
        body: JSON.stringify({ decision: "APPROVED", planDigest: st.planDigest, actor: "demo:auto" }),
      });
    }
  }, APPROVE_AFTER * 1000);
}

const t0 = Date.now();
const result = await runMission(
  {
    executor, journal, model, budget, research, collector: new ZooCollector({ source: zoo, journal, runId }), collectEveryMs: 400,
    intent: zooIntentSink(zoo), delegation: { maxDepth: 2 },
    validation: new LocalRunner({ journal, runId, workspaceRoot: ws, commands: billingAcceptance(FX), generation: lock.generation }),
    orchestration: {
      catalog, profiles: PROFILES, executor, workspaceRoot: ws, generation: lock.generation,
      registry: new AgentRunnerRegistry([new NativeLoopRunner(model, undefined, research), new CliOneShotRunner()]),
      approval: { pollMs: 300 },
    },
  },
  { runId, objective: BILLING_OBJECTIVE, plan, acceptance: ["unit", "oracle"], limits: { concurrency: 3, maxRepairRounds: 1, missionMs: 10 * 60_000, loop: { maxSteps: 25, maxTokensPerCall: 6000 } } },
);
const usd = journal.listModelCalls().reduce((a, c) => a + (c.costUsd ?? 0), 0);
console.log(`\nmission ${result.status}${result.reason ? ` — ${result.reason}` : ""} in ${((Date.now() - t0) / 1000).toFixed(0)}s · model $${usd.toFixed(4)} · ${journal.listResearchCalls().length} searches`);
console.log("UI stays up; Ctrl+C to stop.");
process.on("SIGINT", async () => {
  await api.close();
  await zoo.close();
  journal.close();
  lock.release();
  process.exit(0);
});
