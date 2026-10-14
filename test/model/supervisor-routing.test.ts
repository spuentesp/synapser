import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { defaultModelConfig, systemModelConfig, type ProviderConfig } from "../../src/model/config.ts";
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible-provider.ts";
import type { RoleConfig } from "../../src/model/config.ts";
import type { Role } from "../../src/model/types.ts";

// Plan 17 P17.6: roles.supervisor on a non-default model reaches a local endpoint with that model and the key from
// the operator's environment. The key value is fake and is never written into the configuration.
describe("plan 17 P17.6: roles.supervisor routes to the model the operator assigned", () => {
  const seen: { auth: string | undefined; model: string }[] = [];
  let server: ReturnType<typeof createServer>;
  let port = 0;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body) as { model: string };
        seen.push({ auth: req.headers["authorization"], model: j.model });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", model: j.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    process.env["SUP_TEST_KEY"] = "sk-test-supervisor-fake";
  });

  after(() => {
    delete process.env["SUP_TEST_KEY"];
    server.close();
  });

  test("the supervisor's request carries the assigned model and key; the default model is not used", async () => {
    const local: ProviderConfig = {
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      apiKeyEnv: ["SUP_TEST_KEY"],
      models: [{ id: "sup-assigned-model" }, { id: "sup-other-model" }],
    };
    const roles = { ...defaultModelConfig().roles, supervisor: { provider: "local-sup", model: "sup-assigned-model", temperature: 0 } as RoleConfig } as Record<Role, RoleConfig>;
    const cfg = systemModelConfig({ ...defaultModelConfig().providers, "local-sup": local }, roles);
    const model = new OpenAICompatibleProvider({ config: cfg });
    const before = seen.length;
    const out = await model.complete({ role: "supervisor", messages: [{ role: "user", content: "hi" }], maxTokens: 16 } as never, { runId: "run-p17-6" });
    assert.ok(out, "the call returned");
    const sent = seen.slice(before);
    assert.deepEqual(sent, [{ auth: "Bearer sk-test-supervisor-fake", model: "sup-assigned-model" }]);
    assert.equal(JSON.stringify(cfg).includes("sk-test-supervisor-fake"), false, "the configuration never holds the key value");
  });
});
