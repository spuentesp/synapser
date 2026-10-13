// Live smoke against Nebius Token Factory. Skipped unless a key is present:
//   npm run test:live        (reads .env via --env-file)
// Costs a few cents at most: one tiny forced tool call per role model.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../../src/model/index.ts";

const KEY = process.env["NEBIUS_API_KEY"] ?? process.env["NEMOTRON_TOKEN"];
const skip = KEY ? false : "no NEBIUS_API_KEY / NEMOTRON_TOKEN in the environment";

const readFiles = {
  type: "function" as const,
  function: {
    name: "read_files",
    description: "Read workspace files.",
    parameters: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
};

test("worker role: forced tool call on the real API, recorded in the journal without the key", { skip, timeout: 120_000 }, async () => {
  const j = Journal.open(mkdtempSync(join(tmpdir(), "live-")), "live-1");
  try {
    const provider = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(j) });
    const budget = new BudgetManager({ maxTokens: 20_000, maxCalls: 5 });
    const r = await provider.complete(
      {
        role: "worker",
        messages: [{ role: "user", content: "Read app/billing.py and app/schema.py." }],
        tools: [readFiles],
        toolChoice: { name: "read_files" },
        maxTokens: 1500,
      },
      { runId: "live-1", taskId: "t1", budget },
    );
    assert.equal(r.toolCalls.length >= 1, true);
    assert.equal(r.toolCalls[0]?.argsValid, true);
    assert.deepEqual((r.toolCalls[0]?.args as { paths: string[] }).paths.sort(), ["app/billing.py", "app/schema.py"]);
    assert.ok(r.usage.promptTokens > 0 && r.usage.completionTokens > 0);
    assert.equal(JSON.stringify(r.assistantMessage).toLowerCase().includes("reasoning"), false);

    const [row] = j.listModelCalls();
    assert.equal(row?.requestedModel, defaultModelConfig().roles.worker.model);
    assert.ok(row?.costUsd !== null && row!.costUsd! > 0, "cost estimated from the price table");
    assert.equal(j.artifacts.get(row!.requestBlob!).toString().includes(KEY!), false);
    assert.equal(j.artifacts.get(row!.responseBlob!).toString().includes(KEY!), false);
    assert.equal(budget.snapshot().calls, 1);
  } finally {
    j.close();
  }
});
