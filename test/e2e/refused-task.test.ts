import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { CliOneShotRunner } from "../../src/agents/adapters.ts";
import { AgentRunnerRegistry, runAndIntegrate } from "../../src/agents/port.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { treeDigest } from "../fixtures/repo.ts";

// Plan 18 E7 (H7.3, as written): a task the agent cannot complete ends in its declared state, and the repository keeps
// no partial change. The fake agent writes a file and then dies with a non-zero exit, so the change is partial by design.
const FAKE = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;
const TASK = { taskId: "t1", objective: "Make a change, then fail.", scope: ["app/billing.py", "app/schema.py"], criteria: ["the change is complete"], planRevision: 1 };
const DIES_MIDWAY: AgentProfile = {
  id: "fake-dies-midway", description: "double", role: "writer", adapter: "cli-oneshot", argv: [process.execPath, FAKE, "crash-midway", "{prompt}"],
  parser: "codex-jsonl", timeoutMs: 20_000, tags: [], enabled: true,
};

describe("H7.3 a task the agent cannot complete ends FAILED, with no partial change in the repository", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  test("the agent writes a partial file and dies: the run is FAILED, the repository is unchanged, and no claim remains", async () => {
    const before = treeDigest(env.ws);
    const r = await runAndIntegrate(new AgentRunnerRegistry([new CliOneShotRunner()]), {
      workspaceRoot: env.ws, runId: RUN, journal: env.journal, executor: env.exec, generation: env.lock.generation, profile: DIES_MIDWAY, task: TASK,
    });
    // The agent did act: it wrote its file and died. The run must say so, and the writer must refuse the change.
    assert.deepEqual(r.run.changedPaths, ["partial.txt"]);
    assert.match(r.run.reason ?? "", /exit code 3/);
    assert.equal(r.run.outcome, "FAILED");
    assert.equal(existsSync(join(env.ws, "partial.txt")), false, "the partial file is not in the repository");
    assert.equal(treeDigest(env.ws), before, "not one byte of the repository changed");
    assert.equal(env.journal.listAgentRuns()[0]?.outcome, "FAILED");
    assert.deepEqual(await env.zoo.listClaims(), []);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });
});
