// REAL Nemotron on Token Factory solves the fixture mission through the whole stack
// (loop → executor → Zoanthrope → journal), judged by the independent oracle it never sees.
//   npm run test:live
// A failure here is information about the model, not necessarily a bug: the transcript is printed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runTask, type StepInfo } from "../../src/agents/native/loop.ts";
import { Executor } from "../../src/executor/executor.ts";
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock } from "../../src/journal/lock.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../../src/model/index.ts";
import { ZooAdapter } from "../../src/zoo/adapter.ts";
import { loadPin } from "../../src/zoo/pin.ts";

const KEY = process.env["NEBIUS_API_KEY"] ?? process.env["NEBIUS_TOKEN"] ?? process.env["NEMOTRON_TOKEN"];
const skip = KEY ? false : "no NEBIUS_API_KEY / NEBIUS_TOKEN / NEMOTRON_TOKEN in the environment";
const FX = resolve("fixtures/billing");

const CONTRACT = [
  "Invoice is a frozen dataclass: Invoice(customer_id: str, subtotal_cents: int, discount_bps: int = 0).",
  "Receipt is a frozen dataclass: Receipt(customer_id: str, subtotal_cents: int, discount_cents: int, total_cents: int).",
  "app/billing.py: compute_receipt(invoice) -> Receipt. discount_cents = floor(subtotal_cents * discount_bps / 10000) using INTEGER arithmetic only (no floats); total_cents = subtotal_cents - discount_cents. The receipt keeps customer_id and the original subtotal_cents.",
  "Validation in compute_receipt: subtotal_cents must be an int >= 0 and discount_bps an int in 0..10000. bool is NOT accepted as a number, floats and strings are rejected. Raise ValueError for out-of-range ints and TypeError for wrong types.",
  "app/client.py: checkout(customer_id, subtotal_cents, discount_bps=0) -> Receipt; render_receipt(receipt) -> str that contains 'customer=<id>', 'subtotal=<cents>', 'discount=<cents>' and 'total=<cents>' as space-separated key=value pairs.",
];

test("Nemotron (worker role) completes the discount mission and the independent oracle passes", { skip, timeout: 600_000 }, async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "live-ws-")));
  cpSync(join(FX, "baseline"), ws, { recursive: true });
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "live-state-")));
  const lock = acquireWorkspaceLock(stateDir, ws);
  const journal = Journal.open(stateDir, "live-mission");
  const zoo = await ZooAdapter.open(loadPin(), ws);
  const model = new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) });
  const executor = new Executor({ workspace: ws, runId: "live-mission", journal, zoo, generation: lock.generation });
  const budget = new BudgetManager({ maxTokens: 250_000, maxCalls: 40 });
  const trace: string[] = [];
  const onStep = (s: StepInfo) => trace.push(`${String(s.step).padStart(2)} ${s.tool ?? "-"} ${s.ok ? "ok" : "REJECTED"}${s.detail ? ` (${s.detail})` : ""}`);

  try {
    const r = await runTask(
      { model, executor, journal, runId: "live-mission", budget, onStep, limits: { maxSteps: 25, maxTokensPerCall: 6000 } },
      {
        taskId: "t1",
        objective: "Add per-customer discounts, expressed in basis points, to this small Python billing library. Money is integer cents.",
        scope: ["app/billing.py", "app/schema.py", "app/client.py"],
        criteria: CONTRACT,
        planRevision: 1,
      },
    );
    const oracle = spawnSync("python3", ["-m", "unittest", "discover", "-s", join(FX, "oracle")], {
      cwd: ws,
      env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    });
    const calls = journal.listModelCalls();
    const cost = calls.reduce((a, c) => a + (c.costUsd ?? 0), 0);
    const tokens = calls.reduce((a, c) => a + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0);
    console.log(`\n--- live mission ---\nstatus=${r.status} steps=${r.steps} modelCalls=${r.modelCalls} tokens=${tokens} cost≈$${cost.toFixed(4)}`);
    console.log(trace.join("\n"));
    console.log(`oracle exit=${oracle.status}\n${oracle.status === 0 ? "" : oracle.stderr.split("\n").slice(-25).join("\n")}`);

    assert.equal(r.status, "FINISHED", `loop ended as ${r.status}: ${r.detail ?? ""}`);
    assert.equal(oracle.status, 0, "the independent oracle must pass on the final files");
    assert.deepEqual(await zoo.listClaims(), [], "nothing left held");
  } finally {
    await zoo.close();
    journal.close();
    lock.release();
  }
});
