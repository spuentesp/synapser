// AgentRunner conformance: ONE set of assertions, run against every implementation of the port.
// A new adapter (e.g. "orca") is done when it passes this file with its own `makeImpl` entry.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { CliOneShotRunner, NativeLoopRunner } from "../../src/agents/adapters.ts";
import { AgentRunnerRegistry, type AgentRunRequest, runAndIntegrate } from "../../src/agents/port.ts";
import { ModelError } from "../../src/model/types.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { call, lastTool, ScriptedModel, type Decision } from "../agent/scripted.ts";

const FAKE = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;
const MARK = "# edited by the agent";
const TASK = { taskId: "t1", objective: "Append a marker to the schema file.", scope: ["app/billing.py", "app/schema.py"], criteria: ["the marker line exists once"], planRevision: 1 };

type Scenario = "happy" | "runner-fails" | "out-of-scope" | "foreign-edit-during-run";
interface Impl {
  name: "native" | "cli-oneshot";
  build(s: Scenario, env: Env): { registry: AgentRunnerRegistry; profile: AgentProfile };
}

// ---- the native adapter: a scripted Nemotron stand-in ------------------------------------------
const nativeModel = (s: Scenario, env: Env) =>
  new ScriptedModel((m, n): Decision => {
    const last = lastTool(m);
    const append = (cur: string) => ({ path: "app/schema.py", old: cur.slice(-40), new: `${cur.slice(-40)}\n${MARK}\n` });
    if (s === "runner-fails") return n === 1 ? { calls: [call("read_files", { paths: ["app/schema.py"] })] } : { throws: new ModelError("UNAVAILABLE", "503") };
    if (s === "out-of-scope") {
      if (n === 1) return { calls: [call("read_files", { paths: ["app/schema.py", "README.md"] })] };
      if (n === 2) return { calls: [call("write_file", { path: "README.md", content: "# not yours\n" }), call("apply_changes", {})] };
      return { calls: [call("finish", { summary: "tried" })] };
    }
    // happy / foreign-edit-during-run
    if (last === null || last.status === "STALE_VIEW") return { calls: [call("read_files", { paths: ["app/schema.py"] })] };
    if (last.files && last.note) {
      const cur = String(last.files[0].content);
      if (s === "foreign-edit-during-run" && n === 2) env.write("app/schema.py", `${env.read("app/schema.py")}# a human edit\n`);
      return { calls: [call("replace_in_file", append(cur)), call("apply_changes", {})] };
    }
    if (last.status === "SETTLED") return { calls: [call("finish", { summary: "done" })] };
    return { calls: [call("finish", { summary: `stuck ${JSON.stringify(last)}` })] };
  });

const IMPLS: Impl[] = [
  {
    name: "native",
    build: (s, env) => ({
      registry: new AgentRunnerRegistry([new NativeLoopRunner(nativeModel(s, env), { applyMaxAttempts: 2, applyBackoffMs: 5 })]),
      profile: BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!,
    }),
  },
  {
    name: "cli-oneshot",
    build: (s) => {
      const mode = s === "runner-fails" ? "error-exit0" : s === "out-of-scope" ? "outside-scope" : s === "foreign-edit-during-run" ? "slow-edit-schema" : "edit-schema";
      return {
        registry: new AgentRunnerRegistry([new CliOneShotRunner()]),
        profile: {
          id: "fake-cli", description: "double", role: "writer", adapter: "cli-oneshot", argv: [process.execPath, FAKE, mode, "{prompt}"],
          parser: s === "runner-fails" ? "mimo-json" : "codex-jsonl", timeoutMs: 20_000, tags: [], enabled: true,
        },
      };
    },
  },
];

for (const impl of IMPLS) {
  describe(`AgentRunner conformance — ${impl.name}`, () => {
    let env: Env;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => env.close());

    const exec = async (s: Scenario, alsoDuring?: () => void) => {
      const { registry, profile } = impl.build(s, env);
      const req: AgentRunRequest = {
        profile, task: TASK, workspaceRoot: env.ws, runId: RUN, journal: env.journal, executor: env.exec, generation: env.lock.generation,
      };
      const p = runAndIntegrate(registry, req);
      alsoDuring?.();
      return p;
    };
    const occurrences = (needle: string) => (env.read("app/schema.py").split(needle).length - 1);

    test("happy path: the change lands once, through the executor, and the ledger row is complete", async () => {
      const r = await exec("happy");
      assert.equal(r.run.outcome, "SUCCEEDED", JSON.stringify(r));
      assert.equal(r.run.adapter, impl.name);
      assert.ok(["DIRECT", "INTEGRATED"].includes(r.integration.status), r.integration.status);
      assert.equal(occurrences(MARK), 1, "applied exactly once");
      assert.deepEqual(r.run.changedPaths, ["app/schema.py"]);
      assert.deepEqual(await env.zoo.listClaims(), []);
      assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);

      const rows = env.journal.listAgentRuns();
      assert.equal(rows.length, 1, "one ledger row per run");
      const row = rows[0]!;
      assert.equal(row.adapter, impl.name);
      assert.equal(row.profileId, r.run.profileId);
      assert.equal(row.outcome, "SUCCEEDED");
      assert.ok(row.finishedAt >= row.startedAt && row.durationMs >= 0);
      assert.deepEqual(row.changes.map((c) => c.path), ["app/schema.py"]);
      assert.ok(env.journal.listEvents().some((e) => e.entity === "agent_run" && e.entityId === row.agentRunId && e.toState === "SUCCEEDED"));
    });

    test("usage is uniform: numbers or null, never NaN/negative/undefined; provenance always set", async () => {
      const r = await exec("happy");
      const u = r.run.usage;
      for (const v of [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.reasoningTokens, u.costUsd, u.turns, u.apiMs]) {
        assert.ok(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0), `bad usage value ${String(v)}`);
      }
      assert.ok(["reported", "log", "unknown"].includes(u.provenance));
      const row = env.journal.listAgentRuns()[0]!;
      assert.equal(row.usageProvenance, u.provenance);
      assert.equal(row.inputTokens, u.inputTokens);
      assert.equal(row.costUsd, u.costUsd);
    });

    test("a run that fails is FAILED, recorded, and changes nothing", async () => {
      const before = env.read("app/schema.py");
      const r = await exec("runner-fails");
      assert.equal(r.run.outcome, "FAILED");
      assert.ok(r.run.reason);
      assert.equal(env.read("app/schema.py"), before);
      assert.equal(env.journal.listAgentRuns()[0]?.outcome, "FAILED");
      assert.deepEqual(await env.zoo.listClaims(), []);
    });

    test("scope is enforced by the executor, not by the adapter: nothing outside it is written", async () => {
      const r = await exec("out-of-scope");
      assert.equal(existsLive("secrets.txt"), false);
      assert.equal(env.read("README.md").includes("not yours"), false);
      // whatever the adapter did, the invariants hold and nothing is left locked
      assert.deepEqual(await env.zoo.listClaims(), []);
      assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
      if (impl.name === "cli-oneshot") {
        assert.equal(r.integration.status, "REJECTED", "the whole change set is refused");
        assert.equal(occurrences(MARK), 0, "the in-scope half was not applied either");
      }
    });

    test("no lost update: a human edit made while the agent worked survives, and the agent's change is never applied twice", async () => {
      const r = await exec("foreign-edit-during-run", () => {
        // the CLI adapter's agent takes ~500 ms; the native script edits during its own turn
        if (impl.name === "cli-oneshot") setTimeout(() => env.write("app/schema.py", `${env.read("app/schema.py")}# a human edit\n`), 150);
      });
      assert.equal(occurrences("# a human edit"), 1, "the foreign edit is intact");
      assert.ok(occurrences(MARK) <= 1, "the agent's change is applied at most once");
      assert.ok(r.integration.status !== "FAILED");
      if (impl.name === "cli-oneshot") assert.equal(r.integration.status, "STALE_VIEW", "the broker reports staleness instead of overwriting");
      if (impl.name === "native") assert.equal(occurrences(MARK), 1, "the native loop re-read and re-applied on top");
      assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
    });

    function existsLive(rel: string) {
      try {
        env.read(rel);
        return true;
      } catch {
        return false;
      }
    }
  });
}

describe("AgentRunnerRegistry", () => {
  test("an adapter with no registered runner is a loud error, not a silent fallback", () => {
    const reg = new AgentRunnerRegistry([new CliOneShotRunner()]);
    assert.throws(() => reg.for(BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!), /no runner registered for adapter "native"/);
    assert.deepEqual(reg.adapters(), ["cli-oneshot"]);
  });
  test("two runners for the same adapter are refused", () => {
    assert.throws(() => new AgentRunnerRegistry([new CliOneShotRunner(), new CliOneShotRunner()]), /duplicate runner/);
  });
});
