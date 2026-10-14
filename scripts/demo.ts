// Offline, deterministic demo: a real mission on the real executor, journal and Zoanthrope, driven by
// scripted agents with realistic pauses, and the UI served on top of it.
//   node scripts/demo.ts [--port 4173] [--approve-after SECONDS]
// Without --approve-after the gated step waits for a human (open the Approvals view).
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../src/api/server.ts";
import { CliOneShotRunner, NativeLoopRunner } from "../src/agents/adapters.ts";
import { AgentRunnerRegistry } from "../src/agents/port.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../src/agents/profile.ts";
import { Executor } from "../src/executor/executor.ts";
import { journalRecorder } from "../src/model/recorder.ts";
import type { CallContext, ModelPort, ModelRequest, ModelResponse } from "../src/model/types.ts";
import { Journal } from "../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../src/journal/lock.ts";
import { BILLING_OBJECTIVE, billingAcceptance } from "../src/mission/billing-fixture.ts";
import type { Plan } from "../src/mission/plan.ts";
import { runMission } from "../src/mission/runner.ts";
import { buildCatalog } from "../src/orchestration/catalog.ts";
import { ZooCollector } from "../src/zoo/collector.ts";
import { zooIntentSink } from "../src/zoo/intent.ts";
import { LocalRunner } from "../src/validation/runner.ts";
import { ZooAdapter } from "../src/zoo/adapter.ts";
import { loadPin } from "../src/zoo/pin.ts";
import { call, lastTool, ScriptedModel } from "../test/agent/scripted.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] as string) : d;
};
const PORT = Number(arg("port", "4173"));
const APPROVE_AFTER = Number(arg("approve-after", "0"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FX = resolve("fixtures/billing");
const sol = (p: string) => readFileSync(join(FX, "solution", p), "utf8");

const ws = realpathSync(mkdtempSync(join(tmpdir(), "demo-ws-")));
cpSync(join(FX, "baseline"), ws, { recursive: true });
const state = realpathSync(mkdtempSync(join(tmpdir(), "demo-state-")));
const runId = "demo-billing";
const lock = acquireWorkspaceLock(state, ws);
const journal = Journal.open(state, runId);
const zoo = await ZooAdapter.open(loadPin(), ws);
const executor = new Executor({ workspace: ws, runId, journal, zoo, generation: lock.generation });

// One scripted "brain" for every native task. It knows the reference solution and pauses like a model.
const brain = new ScriptedModel(async (messages) => {
  await sleep(500 + Math.random() * 900);
  const first = messages.find((m) => m.role === "user")!.content!;
  // files only: a directory entry in the scope is permission, not something to read
  const scope = (/SCOPE[^:]*: (.*)/.exec(first)?.[1] ?? "").split(", ").filter((p) => p && !p.endsWith("/"));
  const last = lastTool(messages);
  const isApi = /Implement the discount computation/.test(first);
  if (isApi && last === null) {
    return { calls: [call("request_subtask", { objective: "Write unittest cases for the discount contract", scope: ["tests/test_discount.py"], criteria: ["covers 0 and 10000 bps and floor rounding"], why: "tests are separable from the implementation" })] };
  }
  if (last === null || last.status === "STALE_VIEW" || last.error === "READ_FIRST" || (isApi && last.status === "ACCEPTED")) return { calls: [call("read_files", { paths: scope })] };
  if (last.files && last.note) {
    const cur = new Map<string, string>(last.files.map((f: { path: string; content?: string }) => [f.path, f.content ?? ""]));
    return {
      calls: [
        ...scope.map((p) => call("write_file", { path: p, content: p === "README.md" ? `${cur.get(p) ?? "# billing\n"}\n## Discounts\nPass discount_bps (0..10000) to checkout().\n` : sol(p) })),
        call("apply_changes", {}),
      ],
    };
  }
  if (last.status === "WAITING_RESOURCE") return { calls: [call("apply_changes", {})] };
  return { calls: [call("finish", { summary: "implemented the part of the contract that lives in my scope" })] };
});

/** Records each scripted call like the real provider would, under an honest model name with no price. */
const record = journalRecorder(journal);
let n = 0;
const brainPort: ModelPort = {
  async complete(req: ModelRequest, ctx: CallContext): Promise<ModelResponse> {
    const t0 = Date.now();
    const res = await brain.complete(req, ctx);
    const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
    const completionTokens = Math.ceil(JSON.stringify(res.assistantMessage).length / 4);
    record({
      callId: `demo-${++n}`, runId: ctx.runId, taskId: ctx.taskId ?? null, role: req.role, requestedModel: "scripted/demo-agent", servedModel: "scripted/demo-agent",
      baseUrl: "demo://offline", startedAt: t0, latencyMs: Date.now() - t0, httpStatus: 200, retries: 0, usage: { promptTokens, completionTokens, reasoningTokens: 0 },
      finishReason: res.finishReason, fallbackUsed: false, error: null, request: { messages: req.messages.length }, response: { calls: res.toolCalls.map((c) => c.name) },
    });
    return res;
  },
};

const ADVISOR: AgentProfile = {
  id: "claude-opus-advisor", description: "advisor (demo double)", role: "advisor", argv: [process.execPath, resolve("test/fixtures/fake-agent.mjs"), "noop", "{prompt}"],
  parser: "codex-jsonl", timeoutMs: 20_000, tags: ["review", "advice"], enabled: true,
};
const PROFILES = [BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!, ADVISOR];
const catalog = buildCatalog(PROFILES, [], { knownUsdPerRun: { "nemotron-worker": 0.003, "claude-opus-advisor": 0.08 } });

const plan: Plan = {
  tasks: [
    { id: "api", objective: "Implement the discount computation and its validation in the billing module", scope: ["app/billing.py", "app/schema.py", "tests/"], criteria: ["compute_receipt applies floor(subtotal*bps/10000)"], deps: [], priority: 10, tags: ["code"] },
    { id: "consumer", objective: "Expose subtotal, discount and total in the local consumer", scope: ["app/client.py", "app/schema.py"], criteria: ["render_receipt shows discount"], deps: [], priority: 10, tags: ["code"] },
    { id: "review", objective: "Review the combined change for contract mismatches", scope: ["app/billing.py", "app/client.py"], criteria: ["findings listed"], deps: ["api", "consumer"], kind: "advise" },
    { id: "docs", objective: "Document the discount parameter in the README", scope: ["README.md"], criteria: ["README mentions discount_bps"], deps: ["review"], gates: ["approval"], tags: ["code"] },
  ],
};

const collector = new ZooCollector({ source: zoo, journal, runId });
const api = createApi({ stateDir: state, journals: new Map([[runId, journal]]) });
const port = await api.listen(PORT);
console.log(`\n  Synapser UI  →  http://127.0.0.1:${port}/\n  run: ${runId}   workspace: ${ws}\n`);
if (APPROVE_AFTER > 0) {
  setTimeout(async () => {
    const digest = (await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/state`)).json() as { planDigest: string }).planDigest;
    await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/approvals/docs`, { method: "POST", headers: { "content-type": "application/json", "x-synapser-token": api.token }, body: JSON.stringify({ decision: "APPROVED", planDigest: digest, actor: "demo:auto" }) });
  }, APPROVE_AFTER * 1000);
}

const result = await runMission(
  {
    executor, journal, model: brainPort, collector, collectEveryMs: 300, intent: zooIntentSink(zoo), delegation: { maxDepth: 2 },
    validation: new LocalRunner({ journal, runId, workspaceRoot: ws, commands: billingAcceptance(FX), generation: lock.generation }),
    orchestration: {
      catalog, profiles: PROFILES, executor, workspaceRoot: ws, generation: lock.generation,
      registry: new AgentRunnerRegistry([new NativeLoopRunner(brainPort), new CliOneShotRunner()]),
      approval: { pollMs: 200 },
    },
  },
  { runId, objective: BILLING_OBJECTIVE, plan, acceptance: ["unit", "oracle"], limits: { concurrency: 3, maxRepairRounds: 1, missionMs: 10 * 60_000 } },
);
console.log(`mission ${result.status}${result.reason ? ` — ${result.reason}` : ""}. UI stays up; Ctrl+C to stop.`);
process.on("SIGINT", async () => {
  await api.close();
  await zoo.close();
  journal.close();
  lock.release();
  process.exit(0);
});
