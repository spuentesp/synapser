import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import type { ProfileCard } from "../../src/orchestration/catalog.ts";
import { Journal } from "../../src/journal/journal.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { BASELINE } from "../executor/env.ts";

// Plan 14 Q5.2 and Q5.3: a library provider and a library agent take part in a real run (ProductionEngine, the journal,
// Zoanthrope and the executor). The planner sees the library agent, a review runs on it through the library provider,
// and the run keeps the snapshot it started with: an edit made after the snapshot never reaches its calls.

const OP: Actor = { id: "ana", role: "operator" };
const KEY = "LIB_E2E_KEY";
const SKILL_TEXT = "Review the change against the house style: short sentences, no jargon.";
const CLI_SKILL_TEXT = "Frozen CLI guidance: preserve public API compatibility.";
const CLI_SKILL_EDIT = "Edited guidance must not enter the already-frozen workflow.";
const FAKE_AGENT = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;

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
  let api: ApiServer | undefined;
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
    await api?.close();
    api = undefined;
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

    // the library states prices; they must not reach the cost of the run (plan 15 D4)
    const provider = (baseUrl: string) => ({ protocol: "openai-compatible", baseUrl, apiKeyEnv: [KEY], models: [{ id: "lib-model", usdPer1MIn: 1, usdPer1MOut: 2 }] });
    const skillRefs: Record<string, readonly string[]> = {};
    let libraryAgentId = "lib-reviewer";
    let plannerSaw: string[] = [];
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: [], profiles: [], providerKeyEnv: [KEY], agentSkills: skillRefs,
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

    api = createApi({ stateDir: state, control: {
      manager: mgr,
      library: lib,
      libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: [KEY] }),
    } });
    const apiBase = `http://127.0.0.1:${await api.listen(0)}`;
    const apiCall = (method: string, path: string, body?: unknown) => fetch(apiBase + path, {
      method,
      headers: { origin: apiBase, "x-synapser-token": api!.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const writeThenRead = async (kind: "providers" | "agents" | "skills", id: string, document: unknown): Promise<string> => {
      const put = await apiCall("PUT", `/api/library/${kind}/${id}`, document);
      const putText = await put.clone().text();
      assert.equal(put.status, 200, `${kind}/${id} write: ${putText}`);
      const written = JSON.parse(putText) as { id: string; kind: string; changed: boolean };
      assert.equal(written.id, id);
      assert.equal(written.kind, kind);
      assert.equal(written.changed, true);
      const get = await apiCall("GET", `/api/library/${kind}/${encodeURIComponent(written.id)}`);
      const getText = await get.clone().text();
      assert.equal(get.status, 200, `${kind}/${id} read: ${getText}`);
      assert.deepEqual((JSON.parse(getText) as { document: unknown }).document, { ...(document as Record<string, unknown>), id }, `${kind}/${id} public read returns the public write`);
      return written.id;
    };
    const providerId = await writeThenRead("providers", "lib-provider", provider(answers.url));
    const agentId = await writeThenRead("agents", "lib-reviewer", { adapter: "native", description: "reviews the change", role: "advisor", tags: ["review"], timeoutMs: 120_000, provider: providerId, model: "lib-model" });
    const skillId = await writeThenRead("skills", "style-guide", { id: "style-guide", name: "style-guide", description: "how to review", content: SKILL_TEXT });
    libraryAgentId = agentId;
    skillRefs[libraryAgentId] = [skillId];

    const created = mgr.create({
      id: "wf-library", title: "Review with a library agent", description: "a review that runs on a library provider", goals: ["the change is reviewed"], nonGoals: ["no other change"],
      conditions: [
        { id: "schema", statement: "the schema file is there", checker: { kind: "file", path: "app/schema.py", assert: "exists" } },
        { id: "review", statement: "the change reads well", required: false, checker: { kind: "review", profile: libraryAgentId, rubric: "judge the change" } },
      ],
    }, OP);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(mgr.start("wf-library", OP).ok, true);
    await mgr.settled("wf-library");

    const workflow = mgr.list().find((item) => item.id === "wf-library");
    assert.equal(workflow?.state, "DONE", JSON.stringify(workflow));
    assert.ok(plannerSaw.includes(libraryAgentId), `the planner's catalog lacks the library agent: ${plannerSaw.join(", ")}`);
    assert.ok(answers.requests.some((r) => r.includes("judge the change")), "the review did not reach the endpoint the snapshot names");
    assert.ok(answers.requests.some((r) => r.includes(SKILL_TEXT)), "the library skill did not reach the endpoint the snapshot names");
    // the run records the skill it used: its id, the digest of its bytes and the mechanism (plan 14 Q5.4)
    const reviews = mgr.journalOf("wf-library")?.listAgentRuns().filter((r) => r.profileId === libraryAgentId) ?? [];
    assert.ok(reviews.length > 0, "the library reviewer left no run record");
    assert.deepEqual(reviews.at(-1)?.skills, [{ id: "style-guide", digest: sha256Bytes(Buffer.from(SKILL_TEXT, "utf8")), mechanism: "prompt-prepend" }]);
    const libraryCalls = mgr.journalOf("wf-library")?.listModelCalls().filter((c) => c.requestedModel === "lib-model") ?? [];
    assert.ok(libraryCalls.length > 0, "the library model left no call record");
    assert.ok(libraryCalls.every((c) => c.costUsd === null), "a library tariff reached the cost of a run");
    assert.equal(after.requests.length, 0, "an edit made after the snapshot redirected the run");
    assert.equal(later.requests.length, 0, "an edit made while planning redirected the run");
  });

  test("a frozen library skill reaches a CLI reviewer through ProductionEngine and its registry", { timeout: 120_000 }, async () => {
    lib.put("skills", "cli-guidance", { id: "cli-guidance", name: "CLI guidance", description: "compatibility rules", content: CLI_SKILL_TEXT }, OP.id);
    const cliProfile = {
      id: "cli-reviewer", description: "local deterministic CLI reviewer", role: "advisor", adapter: "generic-cli",
      argv: [process.execPath, FAKE_AGENT, "skill-prompt", "{prompt}"], parser: "plain", timeoutMs: 10_000,
      tags: ["review"], enabled: true,
    } as const;
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: [], profiles: [cliProfile], agentSkills: { "cli-reviewer": ["cli-guidance"] },
      models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "no changes" })] })),
      planner: async () => ({ tasks: [] }),
      limits: { maxRepairRounds: 0, concurrency: 1, missionMs: 60_000 }, pollMs: 20,
    });
    const snapshotThenEdit = {
      freeze: (j: Journal) => {
        const snapshot = lib.freeze(j);
        lib.put("skills", "cli-guidance", { id: "cli-guidance", name: "CLI guidance", description: "updated", content: CLI_SKILL_EDIT }, OP.id);
        return snapshot;
      },
    } as unknown as LibraryStore;
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: () => new Set([cliProfile.id]),
      engine, library: snapshotThenEdit, pollMs: 20,
    });
    const created = mgr.create({
      id: "wf-cli-skill", title: "Review with a CLI skill", description: "use frozen skill contents", goals: ["the review passes"], nonGoals: ["no other change"],
      conditions: [
        { id: "schema", statement: "the schema file is there", checker: { kind: "file", path: "app/schema.py", assert: "exists" } },
        { id: "review", statement: "the CLI review passes", required: false, checker: { kind: "review", profile: cliProfile.id, rubric: "confirm public API compatibility" } },
      ],
    }, OP);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(mgr.start("wf-cli-skill", OP).ok, true);
    await mgr.settled("wf-cli-skill");

    const runs = mgr.journalOf("wf-cli-skill")?.listAgentRuns().filter((r) => r.profileId === cliProfile.id) ?? [];
    assert.ok(runs.length > 0, "the CLI reviewer left no run record");
    const run = runs.at(-1)!;
    const output = mgr.journalOf("wf-cli-skill")!.artifacts.get(run.stdoutBlob!).toString("utf8");
    assert.ok(output.includes(CLI_SKILL_TEXT), "the CLI process did not receive the frozen skill in its prompt");
    assert.ok(!output.includes(CLI_SKILL_EDIT), "the CLI process saw a post-snapshot skill edit");
    assert.deepEqual(run.skills, [{ id: "cli-guidance", digest: sha256Bytes(Buffer.from(CLI_SKILL_TEXT, "utf8")), mechanism: "prompt-prepend" }]);
  });
});
