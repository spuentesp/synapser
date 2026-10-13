// Live: export a recorded (synthetic, fixture-only) ledger to the configured LangSmith workspace and
// read it back through the API. Skipped without LANGSMITH_KEY. Content is NOT included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportToLangSmith } from "../../src/audit/langsmith.ts";
import { makeEnv } from "../executor/env.ts";
import { buildScenario } from "../audit/scenario.ts";

const KEY = process.env["LANGSMITH_API_KEY"] ?? process.env["LANGSMITH_KEY"];
const skip = KEY ? false : "no LANGSMITH_KEY in the environment";
const API = "https://api.smith.langchain.com";

test("export → LangSmith → read back", { skip, timeout: 120_000 }, async () => {
  const h = { "x-api-key": KEY as string, Accept: "application/json" };
  const ws = (await (await fetch(`${API}/api/v1/workspaces`, { headers: h })).json()) as { id: string }[];
  const tenant = ws[0]!.id;
  const headers = { ...h, "x-tenant-id": tenant };

  const env = await makeEnv();
  try {
    await buildScenario(env);
    const project = `synapser-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    const out = await exportToLangSmith(env.journal, { project, includeContent: false }, { apiKey: KEY as string, workspaceId: tenant });
    assert.ok(out.runs >= 10);

    // ingestion is asynchronous: poll for the project and its runs
    let sessionId: string | null = null;
    let found: { name: string; run_type: string; extra?: { metadata?: Record<string, unknown> } }[] = [];
    for (let i = 0; i < 20 && found.length < out.runs; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!sessionId) {
        const s = (await (await fetch(`${API}/api/v1/sessions?name=${encodeURIComponent(project)}`, { headers })).json()) as { id: string }[];
        sessionId = s[0]?.id ?? null;
      }
      if (sessionId) {
        const res = await fetch(`${API}/api/v1/runs/query`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ session: [sessionId], limit: 100, select: ["id", "name", "run_type", "extra", "error", "total_tokens", "total_cost"] }) });
        found = ((await res.json()) as { runs?: typeof found }).runs ?? [];
      }
    }
    console.log(`exported ${out.runs} runs to project "${project}" (head ${out.head.slice(0, 19)}…); read back ${found.length}`);
    console.log("names:", found.map((r) => `${r.run_type}:${r.name}`).slice(0, 14).join(" | "));
    assert.equal(found.length, out.runs, "every exported run is visible");
    const root = found.find((r) => r.name.startsWith("mission:"));
    assert.equal(root?.extra?.metadata?.["ls_integration"], "synapser");
    assert.equal(root?.extra?.metadata?.["synapser_ledger_head"], out.head);
  } finally {
    await env.close();
  }
});
