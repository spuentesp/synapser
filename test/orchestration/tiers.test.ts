// Plan 13 §7 (T1–T3): tiers, the escalation ladder, pools, configurable agents, and `doctor`.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CliOneShotRunner, NativeLoopRunner } from "../../src/agents/adapters.ts";
import { AgentRunnerRegistry } from "../../src/agents/port.ts";
import { type AgentProfile, type Tier, tierRank } from "../../src/agents/profile.ts";
import { ConfigError, loadConfig } from "../../src/config/load.ts";
import { doctor, type Probe } from "../../src/cli/doctor.ts";
import { validatePlan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import { modelConfigForProvider, type ProviderConfig } from "../../src/model/config.ts";
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible-provider.ts";
import { journalRecorder } from "../../src/model/recorder.ts";
import { buildCatalog, type ProfileCard } from "../../src/orchestration/catalog.ts";
import { PoolLimiter } from "../../src/orchestration/pools.ts";
import { route } from "../../src/orchestration/router.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const card = (id: string, tier: Tier, over: Partial<ProfileCard> = {}): ProfileCard => ({
  id, kinds: ["write"], integration: "pending", tier, pool: null, strengths: [], cost: { basis: "known", usdPerRun: 0.01 }, observed: null, enabled: true, ...over,
});

describe("router tiers (T1)", () => {
  const cat = [card("cheap-a", "cheap"), card("std-a", "standard"), card("adv-a", "advanced")];

  test("the floor is respected and the LOWEST tier that clears it is used", () => {
    const pick = (minTier?: Tier) => {
      const d = route({ kind: "write", ...(minTier ? { minTier } : {}) }, cat);
      return d.ok ? d.profileId : null;
    };
    assert.equal(pick(), "cheap-a");
    assert.equal(pick("cheap"), "cheap-a");
    assert.equal(pick("standard"), "std-a");
    assert.equal(pick("advanced"), "adv-a");
    const none = route({ kind: "write", minTier: "advanced" }, [card("cheap-a", "cheap")]);
    assert.ok(!none.ok);
    assert.deepEqual(none.rejected, [{ profileId: "cheap-a", code: "BELOW_TIER" }]);
  });

  test("T1 as a property: whatever the catalog and floor, the chosen tier is never below the floor, and never higher than needed", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const tiers: Tier[] = ["cheap", "standard", "advanced"];
    for (let i = 0; i < 300; i++) {
      const c = Array.from({ length: 2 + Math.floor(rnd() * 5) }, (_, k) => card(`p${k}`, tiers[Math.floor(rnd() * 3)] as Tier, { cost: { basis: "known", usdPerRun: Math.round(rnd() * 10) / 100 } }));
      const floor = tiers[Math.floor(rnd() * 3)] as Tier;
      const d = route({ kind: "write", minTier: floor }, c);
      const eligible = c.filter((x) => tierRank(x.tier) >= tierRank(floor));
      assert.equal(d.ok, eligible.length > 0);
      if (d.ok) {
        const chosen = c.find((x) => x.id === d.profileId)!;
        assert.ok(tierRank(chosen.tier) >= tierRank(floor));
        assert.equal(tierRank(chosen.tier), Math.min(...eligible.map((x) => tierRank(x.tier))), "the cheapest rung that clears the floor");
      }
    }
  });

  test("a plan's tier is validated, and an unroutable tier is a NO_ROUTE", () => {
    const root = new URL("../../fixtures/billing/baseline", import.meta.url).pathname;
    const t = (over: Record<string, unknown>) => ({ id: "a", objective: "Change the billing module", scope: ["app/billing.py"], criteria: ["c"], deps: [], ...over });
    const check = (tasks: unknown[], catalog = cat) => validatePlan({ tasks }, { workspaceRoot: root, catalog });
    assert.ok(check([t({ tier: "standard" })]).ok);
    const bad = check([t({ tier: "genius" })]);
    assert.ok(!bad.ok && /INVALID_TIER/.test(bad.errors.join("|")));
    const noRoute = check([t({ tier: "advanced" })], [card("cheap-a", "cheap")]);
    assert.ok(!noRoute.ok && /NO_ROUTE.*tier advanced or above/.test(noRoute.errors.join("|")));
  });
});

describe("the escalation ladder (T2) in a mission", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const profiles = (cfg: { cheap: string; std: string; adv: string }): AgentProfile[] => [
    { ...cli("w-cheap", cfg.cheap), tier: "cheap", tags: ["schema"] },
    { ...cli("w-std", cfg.std), tier: "standard", tags: ["schema"] },
    { ...cli("w-adv", cfg.adv), tier: "advanced", tags: ["schema"] },
  ];
  const go = (ps: AgentProfile[], maxTaskAttempts: number) => {
    const model = new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] }));
    return runMission(
      {
        executor: env.exec, journal: env.journal, model,
        validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema"], timeoutMs: 20_000 }], generation: env.lock.generation }),
        orchestration: {
          catalog: buildCatalog(ps, [], { knownUsdPerRun: { "w-cheap": 0.001, "w-std": 0.02, "w-adv": 0.2 } }),
          profiles: ps, registry: new AgentRunnerRegistry([new NativeLoopRunner(model), new CliOneShotRunner()]),
          executor: env.exec, workspaceRoot: env.ws, generation: env.lock.generation,
        },
      },
      { runId: RUN, objective: "o", plan: { tasks: [{ id: "schema", objective: "Mark the schema file", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"] }] }, acceptance: ["imports"], limits: { maxRepairRounds: 0, maxTaskAttempts, missionMs: 60_000 } },
    );
  };
  const dispatched = () => env.journal.listEvents().filter((e) => e.entity === "dispatch").map((e) => `${(e.data as { profile: string }).profile}/${(e.data as { tier: string }).tier}`);

  test("cheap fails → standard succeeds: each failure raises the floor by exactly one rung", async () => {
    const r = await go(profiles({ cheap: "error-exit0", std: "edit-schema", adv: "edit-schema" }), 3);
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.deepEqual(dispatched(), ["w-cheap/cheap", "w-std/standard"], "never jumped straight to the expensive one");
  });

  test("it is finite and climbs all three rungs, then stops (a mission cannot spend forever)", async () => {
    const r = await go(profiles({ cheap: "error-exit0", std: "error-exit0", adv: "error-exit0" }), 5);
    assert.equal(r.status, "FAILED");
    // three rungs, then the top rung is retried at most up to maxTaskAttempts, never beyond
    const d = dispatched();
    assert.deepEqual(d.slice(0, 3), ["w-cheap/cheap", "w-std/standard", "w-adv/advanced"]);
    assert.ok(d.length <= 5, d.join(","));
    assert.equal(env.journal.listEvents().filter((e) => e.entity === "task_retry").length, d.length - 1);
  });
});

describe("pools (T3)", () => {
  test("a pool never exceeds maxConcurrent; waiters are served in order; unpooled agents are untouched", async () => {
    const lim = new PoolLimiter([{ id: "claude", members: ["a", "b"], maxConcurrent: 2 }]);
    let live = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (i: number) =>
      lim.run(i % 2 ? "a" : "b", async () => {
        live++;
        peak = Math.max(peak, live);
        order.push(i);
        await new Promise((r) => setTimeout(r, 25));
        live--;
        return i;
      });
    const free = lim.run("unpooled", async () => "ran immediately");
    const res = await Promise.all([...Array.from({ length: 7 }, (_, i) => job(i)), free]);
    assert.deepEqual(res.slice(0, 7), [0, 1, 2, 3, 4, 5, 6], "every job completed");
    assert.equal(peak, 2);
    assert.equal(lim.peak("claude"), 2);
    assert.equal(lim.inUse("claude"), 0, "all slots returned");
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6], "FIFO");
    assert.equal(res[7], "ran immediately");
  });

  test("a throwing job still frees its slot", async () => {
    const lim = new PoolLimiter([{ id: "p", members: ["x"], maxConcurrent: 1 }]);
    await assert.rejects(lim.run("x", async () => { throw new Error("boom"); }));
    assert.equal(await lim.run("x", async () => "next"), "next");
  });
});

describe("configurable agents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfg-"));
  });
  const load = (raw: unknown) => {
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ workspace: dir, stateDir: join(dir, "s"), ...(raw as object) }));
    return loadConfig({ path: p });
  };

  test("extend a builtin, point native agents at reusable providers, wrap ANY CLI; pools assign members", () => {
    const c = load({
      profiles: ["codex-writer"],
      providers: {
        local: { protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1/", apiKeyEnv: ["LOCAL_LLM_KEY"], models: [{ id: "llama3.1", usdPer1MIn: 0.1, usdPer1MOut: 0.2 }] },
      },
      agents: [
        { id: "codex-fast", extends: "codex-writer", tier: "cheap", tags: ["boilerplate"] },
        { id: "local-llama", adapter: "native", role: "writer", tier: "cheap", provider: "local", model: "llama3.1" },
        { id: "my-tool", adapter: "generic-cli", role: "writer", argv: ["mytool", "--task", "{prompt}"], tier: "standard" },
      ],
      pools: [{ id: "codex", members: ["codex-writer", "codex-fast"], maxConcurrent: 1 }],
    });
    const by = Object.fromEntries(c.profiles.map((p) => [p.id, p]));
    assert.equal(by["codex-fast"]!.tier, "cheap");
    assert.deepEqual(by["codex-fast"]!.argv, by["codex-writer"]!.argv, "inherits everything it does not override");
    assert.equal(by["local-llama"]!.provider, "local");
    assert.equal(by["local-llama"]!.model, "llama3.1");
    assert.equal(c.providers["local"]!.models[0]!.usdPer1MOut, 0.2);
    assert.equal(by["my-tool"]!.parser, "plain", "a CLI without a known event format uses the plain parser");
    assert.equal(by["my-tool"]!.adapter, "generic-cli");
    assert.equal(by["codex-fast"]!.pool, "codex");
    assert.equal(by["codex-writer"]!.pool, "codex");
    assert.deepEqual(c.pools, [{ id: "codex", members: ["codex-writer", "codex-fast"], maxConcurrent: 1 }]);
  });

  test("an old inline endpoint migrates to a deterministic provider reference", () => {
    const c = load({
      agents: [{ id: "local-llama", adapter: "native", endpoint: { baseUrl: "http://127.0.0.1:11434/v1/", model: "llama3.1", apiKeyEnv: ["LOCAL_LLM_KEY"] } }],
    });
    const profile = c.profiles.find((item) => item.id === "local-llama")!;
    assert.deepEqual([profile.provider, profile.model], ["legacy-local-llama", "llama3.1"]);
    assert.deepEqual(c.providers["legacy-local-llama"], {
      protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1/", apiKeyEnv: ["LOCAL_LLM_KEY"], models: [{ id: "llama3.1" }],
    });
    assert.equal("endpoint" in profile, false, "the runtime representation no longer carries inline credentials metadata");
  });

  test("an invalid file is rejected WHOLE, each problem named (K2)", () => {
    assert.throws(
      () =>
        load({
          agents: [
            { id: "bad-tier", extends: "codex-writer", tier: "genius" },
            { id: "shell-string", adapter: "cli-oneshot", role: "writer", argv: ["sh -c rm -rf /", "{prompt}"] },
            { id: "remote-http", adapter: "native", endpoint: { baseUrl: "http://evil.example.com/v1/", model: "m", apiKeyEnv: ["K"] } },
            { id: "unknown-provider", adapter: "native", provider: "missing", model: "m" },
            { id: "unknown-model", adapter: "native", provider: "priced", model: "other" },
            { id: "codex-writer", adapter: "cli-oneshot", argv: ["x", "{prompt}"] },
          ],
          providers: {
            priced: { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["MODEL_KEY"], models: [{ id: "m" }] },
            "bad-price": { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["MODEL_KEY"], models: [{ id: "m", usdPer1MIn: -1, usdPer1MOut: 1 }] },
            broken: { protocol: "grpc", baseUrl: "http://remote.example/v1/", apiKeyEnv: ["not-valid"], models: [] },
          },
          pools: [{ id: "p", members: ["ghost"], maxConcurrent: 1 }],
        }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        const m = (e as ConfigError).errors.join("\n");
        assert.match(m, /tier must be one of/);
        assert.match(m, /no spaces|shell strings/);
        assert.match(m, /must be https/);
        assert.match(m, /unknown provider "missing"/);
        assert.match(m, /not declared by provider "priced"/);
        assert.match(m, /unsupported protocol/);
        assert.match(m, /non-negative finite number/);
        assert.match(m, /already a profile/);
        assert.match(m, /unknown profile "ghost"/);
        return true;
      },
    );
  });
});

describe("an agent backed by another OpenAI-compatible endpoint", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  test("same loop, same executor, a different brain: its model, key and usage are used and recorded", async () => {
    const seen: { auth: string | undefined; model: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body) as { model: string };
        seen.push({ auth: req.headers["authorization"], model: j.model });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", model: "local-model-v1", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "nothing to do" }) } }] } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env["TEST_ENDPOINT_KEY"] = "sk-test-endpoint";
    try {
      const profile: AgentProfile = {
        id: "local-llama", description: "x", role: "writer", adapter: "native", argv: [], parser: "plain", timeoutMs: 60_000, tags: [], enabled: true, tier: "cheap",
        provider: "local", model: "llama3.1-8b", nativeRole: "worker",
      };
      const provider: ProviderConfig = { protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1/`, apiKeyEnv: ["TEST_ENDPOINT_KEY"], models: [{ id: "llama3.1-8b" }] };
      const shared = new ScriptedModel(() => ({ calls: [call("finish", { summary: "SHOULD NOT BE USED" })] }));
      const own = new OpenAICompatibleProvider({ config: modelConfigForProvider("local", provider, profile.model!), onCall: journalRecorder(env.journal) });
      const runner = new NativeLoopRunner(shared, undefined, undefined, (p) => (p.provider === "local" ? own : null));
      const out = await runner.run({
        profile, task: { taskId: "t1", objective: "do nothing at all", scope: ["app/schema.py"], criteria: ["c"], planRevision: 1 },
        workspaceRoot: env.ws, runId: RUN, journal: env.journal, executor: env.exec, generation: env.lock.generation,
      });
      assert.equal(out.outcome, "SUCCEEDED");
      assert.equal(shared.calls, 0, "the shared model was not touched");
      assert.deepEqual(seen, [{ auth: "Bearer sk-test-endpoint", model: "llama3.1-8b" }]);
      const calls = env.journal.listModelCalls();
      assert.equal(calls.length, 1);
      assert.deepEqual([calls[0]!.servedModel, calls[0]!.promptTokens, calls[0]!.completionTokens], ["local-model-v1", 11, 3]);
      assert.equal(calls[0]!.costUsd, null, "an unpriced model is UNKNOWN cost, not zero");
    } finally {
      delete process.env["TEST_ENDPOINT_KEY"];
      server.close();
    }
  });
});

describe("doctor", () => {
  const probe = (have: Record<string, string>, env: string[]): Probe => ({
    which: async (c) => (c in have ? `/usr/bin/${c}` : null),
    version: async (c) => (c in have ? have[c]! : null),
    env: (n) => env.includes(n),
    nodeVersion: () => "24.2.0",
    exists: () => true,
    writable: () => true,
  });

  test("reports what is installed and usable, and what to enable — without enabling anything", async () => {
    const cfg = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "doc-")) });
    const rep = await doctor({ ...cfg, profiles: cfg.profiles.filter((p) => ["nemotron-worker", "codex-writer", "claude-opus-advisor"].includes(p.id)) }, probe({ git: "git 2.5", python3: "Python 3.12", codex: "codex-cli 0.160", zoanthrope: "zoanthrope 0.1.3" }, ["NEBIUS_TOKEN"]));
    const a = Object.fromEntries(rep.agents.map((x) => [x.id, x]));
    assert.equal(a["codex-writer"]!.available, true);
    assert.equal(a["claude-opus-advisor"]!.available, false, "claude is not installed here");
    assert.match(a["claude-opus-advisor"]!.detail, /claude: not installed/);
    assert.equal(a["claude-sonnet-writer"]!.enabledInConfig, false);
    assert.equal(a["nemotron-worker"]!.available, true, "native agents need only the Nebius key");
    assert.ok(rep.suggestions.some((s) => /enabled in your config but NOT usable here: claude-opus-advisor/.test(s)));
    assert.ok(rep.suggestions.some((s) => /no usable advisor-role agent is enabled/.test(s)), "the only enabled advisor (claude-opus) is not installed");
    assert.equal(rep.checks.find((c) => c.name.startsWith("search key"))!.ok, false, "no Tavily key: reported, and not fatal");
    assert.equal(rep.ok, true);
  });
});
