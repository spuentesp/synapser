// P19.7 S1 adversarial verification: reviews are independent, read-only observations of
// the exact tree accepted by the writer, never another opportunity to change that tree.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const OP: Actor = { id: "operator", role: "operator" };
const WRITER: AgentProfile = { ...cli("writer", "edit-schema"), tags: ["schema"] };
const reviewer = (mode: string, workspaceRoot?: string): AgentProfile => ({
  id: "reviewer", description: "isolated adversarial reviewer", role: "advisor", adapter: "cli-oneshot",
  argv: [process.execPath, new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname, mode, ...(workspaceRoot ? [workspaceRoot] : []), "{prompt}"],
  parser: "codex-jsonl", timeoutMs: 20_000, tags: ["review"], enabled: true,
});

describe("P19.7 S1 reviewer independence and snapshot binding", () => {
  let ws: string;
  let state: string;
  let mgr: WorkflowManager | undefined;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "review-integrity-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "review-integrity-state-")));
  });

  afterEach(async () => {
    await mgr?.close();
    mgr = undefined;
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const createRun = (profiles: AgentProfile[], reviewProfile: string, planProfile = WRITER.id) => {
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: [], profiles,
      models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "planning complete" })] })),
      planner: async () => ({ tasks: [{
        id: "write-schema", objective: "Edit the schema", scope: ["app/schema.py"], criteria: ["schema marker added"], deps: [], tags: ["schema"], serves: ["written"], profile: planProfile,
      }] }),
      limits: { maxRepairRounds: 0, concurrency: 1, missionMs: 60_000 }, pollMs: 20,
    });
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(profiles.map((p) => p.id)), engine, pollMs: 20,
    });
    const made = mgr.create({
      title: "Write then review", description: "Write a schema change and independently inspect it", goals: ["the schema marker is present"], nonGoals: [],
      conditions: [
        { id: "written", statement: "the schema changed", checker: { kind: "diff", require: ["app/schema.py"] } },
        { id: "adversarial-review", statement: "an independent reviewer accepts the change", required: true,
          secondaryAccepted: { actor: OP.id, reason: "operator explicitly accepts reviewer evidence as secondary" },
          checker: { kind: "review", profile: reviewProfile, rubric: "Look for correctness and regression risks." } },
      ],
    }, OP);
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal(mgr.start(made.id, OP).ok, true);
    return made.id;
  };

  test("a profile that wrote in this run cannot review its own output", async () => {
    const id = createRun([WRITER], WRITER.id);
    await mgr!.settled(id);

    assert.equal(mgr!.status(id)!.state, "FAILED", "self-review must fail closed, not accept the writer's own verdict");
    const runs = mgr!.journalOf(id)!.listAgentRuns();
    assert.ok(runs.some((run) => run.profileId === WRITER.id), "the writer step ran before self-review was rejected");
    assert.equal(runs.filter((run) => run.taskId?.startsWith("review-")).length, 0, "no self-review process was launched");
    assert.match(mgr!.status(id)!.conditions.find((condition) => condition.id === "adversarial-review")?.detail ?? "", /review|advisor|independent/i);
  });

  test("a distinct advisor is bound to the condition snapshot and leaves no integrated changes", async () => {
    const ADV = reviewer("review-pass");
    const id = createRun([WRITER, ADV], ADV.id);
    await mgr!.settled(id);

    assert.equal(mgr!.status(id)!.state, "DONE", mgr!.status(id)!.reason ?? "");
    const journal = mgr!.journalOf(id)!;
    const reviewRun = journal.listAgentRuns().find((run) => run.profileId === ADV.id)!;
    assert.ok(reviewRun, "the distinct advisor ran");
    assert.equal(reviewRun.role, "advisor");
    const round = journal.listEvents().find((event) => event.entity === "condition_round")!;
    assert.equal(reviewRun.baseDigest, (round.data as { snapshot: string }).snapshot, "the reviewer must inspect the exact accepted tree");
    assert.deepEqual(reviewRun.changes, [], "review output is observational and is never integrated");
    assert.equal(journal.listAgentRuns().filter((run) => run.profileId === ADV.id).length, 1);
  });

  test("an independent advisor reviews the exact accepted tree, and its copy cannot write back", async () => {
    const ADV = reviewer("review-mutates-copy");
    const id = createRun([WRITER, ADV], ADV.id);
    await mgr!.settled(id);

    assert.equal(mgr!.status(id)!.state, "FAILED", "a reviewer that writes in its private copy cannot pass acceptance");
    const journal = mgr!.journalOf(id)!;
    const reviewRun = journal.listAgentRuns().find((run) => run.profileId === ADV.id)!;
    assert.ok(reviewRun, "a distinct advisor was launched");
    assert.equal(reviewRun.role, "advisor");
    assert.notEqual(reviewRun.profileId, WRITER.id);
    const round = journal.listEvents().find((event) => event.entity === "condition_round")!;
    const expectedSnapshot = (round.data as { snapshot: string }).snapshot;
    assert.equal(reviewRun.baseDigest, expectedSnapshot, "the advisor's copied tree must be the exact condition-round snapshot");
    assert.match(mgr!.status(id)!.conditions.find((condition) => condition.id === "adversarial-review")!.detail ?? "", /write|change|snapshot|consistent/i);
    assert.equal(journal.listAgentRuns().filter((run) => run.profileId === ADV.id).length, 1, "the review result was observed, never integrated as a writer");
  });

  test("a live-tree mutation during review invalidates the result even if the reviewer says PASS", async () => {
    const ADV = reviewer("review-races-workspace", ws);
    const id = createRun([WRITER, ADV], ADV.id);
    await mgr!.settled(id);

    assert.equal(mgr!.status(id)!.state, "FAILED", "the review must fail when the live tree no longer matches the bound snapshot");
    const journal = mgr!.journalOf(id)!;
    const reviewRun = journal.listAgentRuns().find((run) => run.profileId === ADV.id)!;
    const round = journal.listEvents().find((event) => event.entity === "condition_round")!;
    assert.equal(reviewRun.baseDigest, (round.data as { snapshot: string }).snapshot);
    assert.match(mgr!.status(id)!.conditions.find((condition) => condition.id === "adversarial-review")!.detail ?? "", /snapshot|consistent|changed|digest/i);
  });
});
