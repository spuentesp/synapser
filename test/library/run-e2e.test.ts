import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { call, ScriptedModel } from "../agent/scripted.ts";
import type { ProfileCard } from "../../src/orchestration/catalog.ts";
import { Journal } from "../../src/journal/journal.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { BASELINE } from "../executor/env.ts";

// Plan 14 Q5.2 and Q5.3: a library provider and a library agent take part in a real run (ProductionEngine, the journal,
// Zoanthrope and the executor). The planner sees the library agent, a review runs on it through the library provider,
// and the run keeps the snapshot it started with: an edit made after the snapshot never reaches its calls.

const OP: Actor = { id: "ana", role: "operator" };
const KEY = "LIB_E2E_KEY";
const SKILL_TEXT = "Review the change against the house style: short sentences, no jargon.";

/** A stand-in for an OpenAI-compatible endpoint. It answers every request with a finish call and keeps what it was asked. */
async function endpoint(summary: string): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary }) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`;
  return {
    url,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("a library provider and agent in a real run (plan 14 Q5.2, Q5.3)", () => {
  let ws: string;
  let state: string;
  let sj: Journal;
  let lib: LibraryStore;
  let mgr: WorkflowManager | undefined;
  let servers: { close: () => Promise<void> }[] = [];
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "lib-e2e-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "lib-e2e-state-")));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
    process.env[KEY] = "test-key-not-a-secret";
  });
  afterEach(async () => {
    await mgr?.close();
    mgr = undefined;
    for (const s of servers) await s.close();
    servers = [];
    sj.close();
    delete process.env[KEY];
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("the planner sees the library agent, its review runs on the library provider, and an edit made after the snapshot never reaches the run", { timeout: 120_000 }, async () => {
    const answers = await endpoint("VERDICT: PASS"); // the endpoint the run's snapshot names
    const after = await endpoint("VERDICT: FAIL");   // an edit made after the snapshot names this one
    const later = await endpoint("VERDICT: FAIL");   // an edit made while the run is planning names this one
    servers = [answers, after, later];

    const provider = (baseUrl: string) => ({ protocol: "openai-compatible", baseUrl, apiKeyEnv: [KEY], models: [{ id: "lib-model" }] });
    lib.put("providers", "lib-provider", provider(answers.url), OP.id);
    lib.put("agents", "lib-reviewer", { adapter: "native", description: "reviews the change", role: "advisor", tags: ["review"], timeoutMs: 120_000, provider: "lib-provider", model: "lib-model" }, OP.id);

    lib.put("skills", "style-guide", { id: "style-guide", name: "style-guide", description: "how to review", content: SKILL_TEXT }, OP.id);

    let plannerSaw: string[] = [];
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: [], profiles: [], providerKeyEnv: [KEY], agentSkills: { "lib-reviewer": ["style-guide"] },
      models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "nothing to do" })] })),
      planner: async (_w, catalog: ProfileCard[]) => {
        plannerSaw = catalog.map((c) => c.id);
        lib.put("providers", "lib-provider", provider(later.url), OP.id); // an edit while the run is planning
        return { tasks: [] };
      },
      limits: { maxRepairRounds: 0, concurrency: 1, missionMs: 60_000 },
      pollMs: 20,
    });
    // the run takes its snapshot when it starts; the edit that follows it is what the run must not see
    const snapshotThenEdit = {
      freeze: (j: Journal) => {
        const snapshot = lib.freeze(j);
        lib.put("providers", "lib-provider", provider(after.url), OP.id);
        return snapshot;
      },
    } as unknown as LibraryStore;
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: () => new Set(lib.list("agents").map((e) => e.id)),
      engine, library: snapshotThenEdit, pollMs: 20,
    });

    const created = mgr.create({
      id: "wf-library", title: "Review with a library agent", description: "a review that runs on a library provider", goals: ["the change is reviewed"], nonGoals: ["no other change"],
      conditions: [
        { id: "schema", statement: "the schema file is there", checker: { kind: "file", path: "app/schema.py", assert: "exists" } },
        { id: "review", statement: "the change reads well", required: false, checker: { kind: "review", profile: "lib-reviewer", rubric: "judge the change" } },
      ],
    }, OP);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(mgr.start("wf-library", OP).ok, true);
    await mgr.settled("wf-library");

    assert.ok(plannerSaw.includes("lib-reviewer"), `the planner's catalog lacks the library agent: ${plannerSaw.join(", ")}`);
    assert.ok(answers.requests.some((r) => r.includes("judge the change")), "the review did not reach the endpoint the snapshot names");
    assert.ok(answers.requests.some((r) => r.includes(SKILL_TEXT)), "the library skill did not reach the endpoint the snapshot names");
    // the run records the skill it used: its id, the digest of its bytes and the mechanism (plan 14 Q5.4)
    const reviews = mgr.journalOf("wf-library")?.listAgentRuns().filter((r) => r.profileId === "lib-reviewer") ?? [];
    assert.ok(reviews.length > 0, "the library reviewer left no run record");
    assert.deepEqual(reviews.at(-1)?.skills, [{ id: "style-guide", digest: sha256Bytes(Buffer.from(SKILL_TEXT, "utf8")), mechanism: "prompt-prepend" }]);
    assert.equal(after.requests.length, 0, "an edit made after the snapshot redirected the run");
    assert.equal(later.requests.length, 0, "an edit made while planning redirected the run");
  });
});
