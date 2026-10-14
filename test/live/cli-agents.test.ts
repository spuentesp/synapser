// REAL agent CLIs (claude / codex / kimi) make a tiny edit in an isolated copy; the patch broker
// integrates it through claims and digests; the ledger records usage. Spends subscription quota.
//   SYNAPSER_LIVE_CLIS=claude-sonnet-writer,codex-writer,kimi-writer node --env-file=.env --test test/live/cli-agents.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { integrateRun } from "../../src/agents/broker.ts";
import { ProfileRegistry } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { makeEnv, RUN, T1 } from "../executor/env.ts";

const wanted = (process.env["SYNAPSER_LIVE_CLIS"] ?? "").split(",").filter(Boolean);
const PROMPT = "Append exactly one comment line `# audited by synapser` at the very end of app/schema.py. Change nothing else. Do not create any other file.";

for (const id of wanted) {
  test(`live CLI profile ${id}: isolated edit → broker → ledger`, { timeout: 330_000 }, async () => {
    const profile = new ProfileRegistry().get(id);
    assert.ok(profile, `unknown profile ${id}`);
    const env = await makeEnv();
    try {
      const { incarnation } = env.exec.beginSession(T1);
      const before = env.read("app/schema.py");
      const adapter = profile.adapter === "claude-code" ? CLAUDE_CODE_ADAPTER : profile.adapter === "codex" ? CODEX_ADAPTER : profile.adapter === "kimi" ? KIMI_ADAPTER : undefined;
      const run = await runAgent({ profile, prompt: PROMPT, workspaceRoot: env.ws, runId: RUN, taskId: "t1", journal: env.journal, generation: env.lock.generation, ...(adapter ? { adapter } : {}) });
      assert.equal(env.read("app/schema.py"), before, "isolation: nothing changed in the real workspace during the run");

      const integ = run.outcome === "SUCCEEDED" ? await integrateRun(env.exec, { taskId: "t1", incarnation }, run) : null;
      const u = run.usage;
      console.log(
        `\n[${id}] outcome=${run.outcome}${run.reason ? ` (${run.reason})` : ""} exit=${run.exitCode} ${(run.durationMs / 1000).toFixed(1)}s\n` +
          `  usage[${u.provenance}]: in=${u.inputTokens} out=${u.outputTokens} cacheR=${u.cacheReadTokens} cacheW=${u.cacheWriteTokens} usd=${u.costUsd} models=${u.models.join(",") || "-"}\n` +
          `  changes: ${run.changes.map((c) => `${c.op}:${c.path}`).join(", ") || "-"}\n` +
          `  integration: ${integ ? `${integ.status}${integ.detail ? ` (${integ.detail})` : ""}` : "skipped"}\n` +
          `  final: ${(run.finalText ?? "").slice(0, 100).replace(/\n/g, " ")}`,
      );

      const rows = env.journal.listAgentRuns();
      assert.equal(rows.length, 1, "exactly one ledger row");
      assert.equal(rows[0]?.profileId, id);
      assert.notEqual(rows[0]?.usageProvenance, "unknown", "this CLI must report usage somewhere");
      if (run.outcome === "SUCCEEDED") {
        assert.deepEqual(run.changes.map((c) => c.path), ["app/schema.py"], "only the requested file changed");
        assert.equal(integ?.status, "INTEGRATED");
        assert.match(env.read("app/schema.py"), /# audited by synapser\s*$/);
      }
    } finally {
      await env.close();
    }
  });
}
