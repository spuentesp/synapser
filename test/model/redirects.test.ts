import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import type { ProviderConfig } from "../../src/model/config.ts";
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible-provider.ts";
import { ModelError } from "../../src/model/types.ts";

// P15 IC3: a model call never follows a redirect. The prompts and the key stay with the endpoint the document names.

async function listen(handler: (req: { url: string; auth?: string }) => { status: number; headers?: Record<string, string> }) {
  const seen: { url: string; auth?: string }[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers["authorization"] });
      const answer = handler({ url: req.url ?? "", auth: req.headers["authorization"] });
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

describe("model calls do not follow redirects (P15 IC3)", () => {
  test("a 307 from the endpoint is refused: the second host gets no request, no key and no prompt", async () => {
    const target = await listen(() => ({ status: 200 }));
    const origin = await listen(() => ({ status: 307, headers: { location: `${target.url}chat/completions` } }));
    process.env["REDIRECT_TEST_KEY"] = "sk-redirect-test";
    try {
      const provider: ProviderConfig = { protocol: "openai-compatible", baseUrl: origin.url, apiKeyEnv: ["REDIRECT_TEST_KEY"], models: [{ id: "m1" }] };
      const model = new OpenAICompatibleProvider({ config: { providers: { p: provider }, roles: { worker: { provider: "p", model: "m1", temperature: 0 }, supervisor: { provider: "p", model: "m1", temperature: 0 }, repair: { provider: "p", model: "m1", temperature: 0 }, advisor: { provider: "p", model: "m1", temperature: 0 }, chat: { provider: "p", model: "m1", temperature: 0 } }, timeoutMs: 5000, maxRetries: 0, maxConcurrency: 1 } });
      await assert.rejects(model.complete({ role: "worker", messages: [{ role: "user", content: "secret workspace content" }], maxTokens: 16 }, { runId: "r" }), (e: unknown) => e instanceof ModelError && e.kind === "BAD_REQUEST" && /redirect refused/.test(e.message));
      assert.equal(target.seen.length, 0, "the redirect target received nothing");
      assert.equal(origin.seen.length, 1, "only the endpoint the document names was called");
    } finally {
      delete process.env["REDIRECT_TEST_KEY"];
      await origin.close();
      await target.close();
    }
  });
});
