import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { doctor, type Probe } from "../../src/cli/doctor.ts";
import { ConfigError, loadConfig, type SynapserConfig } from "../../src/config/load.ts";
import { defaultModelConfig, type ProviderConfig, systemModelConfig } from "../../src/model/config.ts";

// Plan 14 Q2.3: the system roles (supervisor, worker, repair, advisor, chat) run on the provider and model
// the configuration file assigns them. Defaults are unchanged; a bad assignment is rejected at load.

function load(raw: object): SynapserConfig {
  const root = mkdtempSync(join(tmpdir(), "roles-"));
  const path = join(root, "synapser.config.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "state"), research: false, ...raw }));
  return loadConfig({ path });
}

/** Every problem a configuration file reports, or none when it loads. */
function problemsOf(raw: object): string[] {
  try {
    load(raw);
  } catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  return [];
}

const localProvider = (baseUrl: string): ProviderConfig => ({
  protocol: "openai-compatible",
  baseUrl,
  apiKeyEnv: ["ROLE_TEST_KEY"],
  models: [
    { id: "served-small", usdPer1MIn: 0.5, usdPer1MOut: 1.5 },
    { id: "served-tiny" },
  ],
});

describe("system role assignments (plan 14 Q2.3)", () => {
  test("without a roles block every role keeps its default, and the built model config equals the defaults", () => {
    const cfg = load({});
    assert.deepEqual(cfg.roles, defaultModelConfig().roles);
    assert.deepEqual(systemModelConfig(cfg.providers, cfg.roles), defaultModelConfig());
  });

  test("a role moves to another declared provider and model; a role that is not listed keeps its default", () => {
    const cfg = load({
      providers: { local: localProvider("http://127.0.0.1:9/v1/") },
      roles: {
        worker: { provider: "local", model: "served-small", fallbacks: ["served-tiny"] },
        // the default chat role has a Nemotron fallback; it must not leak into another provider's assignment
        chat: { provider: "local", model: "served-tiny" },
      },
    });
    assert.deepEqual(cfg.roles.worker, { provider: "local", model: "served-small", temperature: 0, fallbacks: ["served-tiny"] });
    assert.deepEqual(cfg.roles.chat, { provider: "local", model: "served-tiny", temperature: 0 });
    assert.deepEqual(cfg.roles.supervisor, defaultModelConfig().roles.supervisor);
    assert.deepEqual(cfg.roles.repair, defaultModelConfig().roles.repair);
  });

  test("an invalid roles block is rejected whole, and every problem is listed at once", () => {
    const problems = problemsOf({
      roles: {
        planner: { provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b" },
        worker: { provider: "ghost", model: "x", temperature: 3 },
        repair: { provider: "tokenfactory" },
        advisor: { provider: "tokenfactory", model: "nvidia/nemotron-3-super-120b-a12b", fallbacks: ["not-declared"] },
        chat: { provider: "tokenfactory", model: "not-declared-either" },
      },
    });
    const text = problems.join("\n");
    assert.match(text, /roles\.planner is not a system role/);
    assert.match(text, /roles\.worker: unknown provider ghost/);
    assert.match(text, /roles\.worker: temperature must be between 0 and 2/);
    assert.match(text, /roles\.repair: model is required/);
    assert.match(text, /roles\.advisor: fallback not-declared is not declared by provider tokenfactory/);
    assert.match(text, /roles\.chat: model not-declared-either is not declared by provider tokenfactory/);
    assert.equal(problems.length, 6, `exactly the six problems above, got:\n${text}`);
  });

  test("redefining a provider that a default role uses fails at load, not at the first call", () => {
    const problems = problemsOf({
      providers: {
        tokenfactory: { protocol: "openai-compatible", baseUrl: "https://api.tokenfactory.nebius.com/v1/", apiKeyEnv: ["NEBIUS_API_KEY"], models: [{ id: "nvidia/Nemotron-3_5-Lightning" }] },
      },
    });
    // the built-in native profiles on tokenfactory break too; those were already rejected before Q2.3
    const roleProblems = problems.filter((p) => p.startsWith("roles."));
    const text = roleProblems.join("\n");
    assert.match(text, /roles\.supervisor: model nvidia\/nemotron-3-super-120b-a12b is not declared by provider tokenfactory \(default assignment; set roles\.supervisor to change it\)/);
    assert.match(text, /roles\.worker: fallback nvidia\/NVIDIA-Nemotron-3-Nano-30B-A3B is not declared by provider tokenfactory \(default assignment/);
    assert.equal(roleProblems.length, 6, `supervisor, worker (model and fallback), repair, advisor and chat:\n${text}`);
    assert.ok(roleProblems.every((p) => /\(default assignment; set roles\.\w+ to change it\)$/.test(p)), text);
  });

  test("a configured role reaches its provider end to end: the request, the model, the key and the declared tariff", async () => {
    const seen: { auth: string | undefined; model: string; path: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const j = JSON.parse(body) as { model: string };
        seen.push({ auth: req.headers["authorization"], model: j.model, path: req.url ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", model: j.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "respuesta local" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env["ROLE_TEST_KEY"] = "sk-role-test";
    try {
      const cfg = load({
        providers: { local: localProvider(`http://127.0.0.1:${port}/v1/`) },
        roles: { chat: { provider: "local", model: "served-small", temperature: 0.1 } },
      });
      const rt = createRuntime(cfg);
      try {
        const out = await rt.chat.send(null, "hola", { id: "tester", role: "operator" });
        assert.equal(out.reply, "respuesta local");
        assert.deepEqual(seen, [{ auth: "Bearer sk-role-test", model: "served-small", path: "/v1/chat/completions" }], "only the chat call, to the configured provider");
        const calls = rt.serverJournal.listModelCalls();
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.role, "chat");
        assert.equal(calls[0]!.requestedModel, "served-small");
        // 11 prompt tokens at $0.5 per million and 3 completion tokens at $1.5 per million
        assert.ok(Math.abs(calls[0]!.costUsd! - 0.00001) < 1e-12, `cost was ${calls[0]!.costUsd}`);
      } finally {
        await rt.close();
      }
    } finally {
      delete process.env["ROLE_TEST_KEY"];
      server.close();
    }
  });

  test("doctor checks the key of every provider a system role runs on, and names the roles it serves", async () => {
    const cfg = load({
      providers: { local: localProvider("http://127.0.0.1:9/v1/") },
      roles: { chat: { provider: "local", model: "served-small" } },
    });
    const probe: Probe = {
      which: async () => null,
      version: async () => null,
      env: (name) => name === "NEBIUS_TOKEN",
      nodeVersion: () => "24.2.0",
      exists: () => true,
      writable: () => true,
    };
    const rep = await doctor(cfg, probe);
    const check = (name: string) => rep.checks.find((c) => c.name === name)!;
    assert.equal(check("model key (tokenfactory)").ok, true, "NEBIUS_TOKEN covers the default roles");
    assert.equal(check("model key (tokenfactory)").detail, "set");
    assert.equal(check("model key (local)").ok, false);
    assert.match(check("model key (local)").detail, /ROLE_TEST_KEY is set — system roles chat cannot run/);
  });
});
