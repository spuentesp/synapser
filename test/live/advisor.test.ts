// LIVE: the advisor against real Nemotron and real Tavily. Skipped without keys.
//   node --env-file=.env --test test/live/advisor.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Advisor } from "../../src/advisor/advisor.ts";
import { Journal } from "../../src/journal/journal.ts";
import { defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../../src/model/index.ts";
import { QueryGuard, researchFromEnv, ResearchSession } from "../../src/research/index.ts";

const haveModel = Boolean(process.env["NEBIUS_API_KEY"] || process.env["NEBIUS_TOKEN"] || process.env["NEMOTRON_TOKEN"]);
const haveSearch = Boolean(process.env["TAVILY_API_KEY"] || process.env["TAVILY_TOKEN"]);
const wf = { id: "wf", title: "Plugin loader", description: "Add a plugin loader to the app using importlib or imp", goals: ["plugins load at startup"], nonGoals: [], conditions: [] };

function setup() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "adv-live-")));
  const j = Journal.open(realpathSync(mkdtempSync(join(tmpdir(), "adv-live-state-"))), "run-live");
  j.tx((t) => {
    t.insertMission({ runId: "run-live", objective: "o", repo: "w", baseSha: "n/a", planRevision: 1, limits: {} });
    t.insertTask({ runId: "run-live", taskId: "loader", actorOwner: "run-live:loader", priority: 0, scope: ["app/plugins.py"], spec: { kind: "agent", objective: "Implement load_plugins() in app/plugins.py using the Python `imp` module (imp.load_source) to import plugin files at startup", criteria: ["plugins in ./plugins are imported"], context: [] }, planRevision: 1, deps: [] });
    t.insertTask({ runId: "run-live", taskId: "docs", actorOwner: "run-live:docs", priority: 0, scope: ["README.md"], spec: { kind: "agent", objective: "Document the plugin loader", criteria: ["README mentions plugins"], context: [] }, planRevision: 1, deps: [] });
  });
  return { ws, j };
}

test("live consult: a failure trigger yields valid, validated interventions (or none), never a crash", { skip: haveModel ? false : "no Nebius key", timeout: 120_000 }, async () => {
  const { j } = setup();
  const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(j) });
  const advisor = new Advisor({ journal: j, runId: "run-live", model, workflow: () => wf });
  const out = await advisor.consult({ kind: "failure", task: "loader", label: "NEEDS_REPLAN", detail: "replace_in_file: old not found (3 times)" });
  console.log(`assessment: ${out.assessment.slice(0, 200)}\ninterventions: ${out.records.map((r) => `${r.type}:${r.task}:${r.state}${r.reason ? ` (${r.reason.slice(0, 60)})` : ""}`).join(" | ") || "(none)"}`);
  assert.ok(out.assessment.length > 0, "the model produced an assessment");
  for (const r of out.records) assert.ok(["APPLIED", "REJECTED", "AWAITING_APPROVAL", "PROPOSED"].includes(r.state));
  assert.ok(j.listEvents().some((e) => e.entity === "advisor_consult" && e.toState === "OK"));
});

test("live pushback: an obsolete assumption is found with SOURCES that were really retrieved", { skip: haveModel && haveSearch ? false : "needs Nebius and Tavily keys", timeout: 180_000 }, async () => {
  const { ws, j } = setup();
  const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(j) });
  const research = new ResearchSession({ port: researchFromEnv(), journal: j, runId: "run-live", guard: new QueryGuard(ws) });
  const advisor = new Advisor({ journal: j, runId: "run-live", model, workflow: () => wf, research });
  const findings = await advisor.critique("loader");
  console.log(`searches=${j.listResearchCalls().length}\n${findings.map((f) => `[${f.severity}] ${f.claim}\n   → ${f.suggestion}\n   sources: ${f.sources.join(", ")}`).join("\n") || "(no findings)"}`);
  const retrieved = new Set(j.listResearchCalls().flatMap((c) => c.urls));
  for (const f of findings) for (const u of f.sources) assert.ok([...retrieved].some((r) => r.replace(/\/$/, "") === u.replace(/\/$/, "")), `finding cites a URL that was never retrieved: ${u}`);
});
