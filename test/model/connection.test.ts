import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import type { ProviderConfig } from "../../src/model/config.ts";
import { testProviderConnection } from "../../src/model/connection.ts";

// Plan 14 Q2.4: a connection test lists the endpoint's models and makes one minimal call. The key goes only
// into the Authorization header of requests to the provider's own baseUrl and never into the report.

const KEY = "sk-connection-test-secret";
const KEY_NAME = "CONNECTION_TEST_KEY";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
}

/** A local OpenAI-compatible server. `route` answers; every request it receives is recorded. */
async function serve(route: (req: { method: string; url: string }) => { status: number; headers?: Record<string, string>; body: string }): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers["authorization"] });
      const answer = route({ method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1/`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const provider = (baseUrl: string): ProviderConfig => ({
  protocol: "openai-compatible",
  baseUrl,
  apiKeyEnv: [KEY_NAME],
  models: [{ id: "served-small", usdPer1MIn: 0.5, usdPer1MOut: 1.5 }, { id: "served-tiny" }],
});

const env = (value: string | undefined): NodeJS.ProcessEnv => ({ [KEY_NAME]: value });
const CHAT_OK = JSON.stringify({ model: "served-small", choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: null } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });

describe("provider connection test (plan 14 Q2.4)", () => {
  test("a reachable endpoint passes: its listing, one minimal call, the declared tariff; the key travels only in Authorization", async () => {
    const up = await serve((req) => (req.url.endsWith("/models") ? { status: 200, body: JSON.stringify({ data: [{ id: "served-small" }, { id: "extra" }] }) } : { status: 200, body: CHAT_OK }));
    try {
      const rep = await testProviderConnection(provider(up.url), { env: env(KEY) });
      assert.equal(rep.ok, true, rep.error ?? "");
      assert.equal(rep.error, null);
      assert.equal(rep.keyFrom, KEY_NAME);
      assert.deepEqual(rep.listing, { status: "served", models: ["served-small", "extra"], notListed: ["served-tiny"] });
      assert.equal(rep.call?.model, "served-small");
      assert.deepEqual(rep.call?.usage, { promptTokens: 4, completionTokens: 2, reasoningTokens: null });
      // 4 prompt tokens at $0.5 per million and 2 completion tokens at $1.5 per million
      assert.ok(Math.abs((rep.call?.costUsd ?? -1) - 0.000005) < 1e-12, `cost was ${rep.call?.costUsd}`);
      assert.deepEqual(up.seen.map((s) => [s.method, s.auth]), [["GET", `Bearer ${KEY}`], ["POST", `Bearer ${KEY}`]]);
      assert.equal(JSON.stringify(rep).includes(KEY), false, "the report never carries the key");
    } finally {
      await up.close();
    }
  });

  test("without a key nothing leaves the process", async () => {
    const up = await serve(() => ({ status: 200, body: CHAT_OK }));
    try {
      const rep = await testProviderConnection(provider(up.url), { env: env(undefined) });
      assert.equal(rep.ok, false);
      assert.equal(rep.keyFrom, null);
      assert.equal(rep.call, null);
      assert.equal(rep.error, `no API key in environment (tried ${KEY_NAME})`);
      assert.equal(up.seen.length, 0, "no request was sent");
    } finally {
      await up.close();
    }
  });

  test("a rejected key is reported as AUTH, and an upstream that echoes the header does not leak it", async () => {
    const up = await serve(() => ({ status: 401, body: JSON.stringify({ error: { message: `bad key, you sent Bearer ${KEY}` } }) }));
    try {
      const rep = await testProviderConnection(provider(up.url), { env: env(KEY) });
      assert.equal(rep.ok, false);
      assert.equal(rep.call?.detail, "AUTH (HTTP 401)");
      assert.deepEqual(rep.listing, { status: "unavailable", detail: "AUTH (HTTP 401)" });
      assert.equal(JSON.stringify(rep).includes(KEY), false, "the report never carries the key");
    } finally {
      await up.close();
    }
  });

  test("a redirect is refused, and the key never reaches the redirect target", async () => {
    const target = await serve(() => ({ status: 200, body: JSON.stringify({ data: [] }) }));
    const origin = await serve(() => ({ status: 302, headers: { location: `${target.url}models` }, body: "" }));
    try {
      const rep = await testProviderConnection(provider(origin.url), { env: env(KEY) });
      assert.equal(rep.ok, false);
      assert.match(rep.call?.detail ?? "", /^redirect refused \(HTTP 302\)/);
      assert.equal(target.seen.length, 0, "the redirect target received nothing");
      assert.equal(JSON.stringify(rep).includes(KEY), false);
    } finally {
      await origin.close();
      await target.close();
    }
  });

  test("an endpoint without a models listing still passes on the minimal call, and invents no cost", async () => {
    const up = await serve((req) => (req.url.endsWith("/models") ? { status: 404, body: "{}" } : { status: 200, body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }] }) }));
    try {
      const rep = await testProviderConnection(provider(up.url), { env: env(KEY) });
      assert.equal(rep.ok, true);
      assert.deepEqual(rep.listing, { status: "unavailable", detail: "NOT_FOUND (HTTP 404)" });
      assert.equal(rep.call?.usage, null);
      assert.equal(rep.call?.costUsd, null);
    } finally {
      await up.close();
    }
  });

  test("a 2xx answer that is not a chat completion is a failed call", async () => {
    const up = await serve((req) => (req.url.endsWith("/models") ? { status: 200, body: JSON.stringify({ data: [] }) } : { status: 200, body: JSON.stringify({ unexpected: true }) }));
    try {
      const rep = await testProviderConnection(provider(up.url), { env: env(KEY) });
      assert.equal(rep.ok, false);
      assert.equal(rep.call?.detail, "response has no choices[0].message");
      assert.equal(rep.error, "chat call failed: response has no choices[0].message");
    } finally {
      await up.close();
    }
  });

  test("a network failure reports the error's name, never its text", async () => {
    const boom = (async () => {
      throw Object.assign(new Error(`connect refused, Authorization: Bearer ${KEY}`), { name: "FetchError" });
    }) as typeof fetch;
    const rep = await testProviderConnection(provider("https://models.example/v1/"), { env: env(KEY), fetch: boom });
    assert.equal(rep.ok, false);
    assert.equal(rep.call?.detail, "network error (FetchError)");
    assert.equal(JSON.stringify(rep).includes(KEY), false);
  });

  test("a request that never answers times out with the configured bound", async () => {
    const hang = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      })) as typeof fetch;
    const rep = await testProviderConnection(provider("https://models.example/v1/"), { env: env(KEY), fetch: hang, timeoutMs: 50 });
    assert.equal(rep.ok, false);
    assert.equal(rep.call?.detail, "no response in 50ms");
  });
});
