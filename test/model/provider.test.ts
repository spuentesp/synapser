// OpenAICompatibleProvider against a local server that emulates Token Factory's failure modes.
// Nothing here touches the network or spends credits.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { BudgetManager, defaultModelConfig, journalRecorder, ModelError, OpenAICompatibleProvider } from "../../src/model/index.ts";
import type { ModelCallRecord, ModelRequest } from "../../src/model/index.ts";

const SECRET = "sk-test-DO-NOT-LEAK-0123456789";
const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
  delayMs?: number;
}
interface Seen {
  model: string;
  body: any;
  auth: string | undefined;
}

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function mock(handler: (seen: Seen, n: number) => Reply) {
  const stats = { hits: 0, inflight: 0, maxInflight: 0, seen: [] as Seen[] };
  const srv = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      stats.hits++;
      stats.inflight++;
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      const body = JSON.parse(raw || "{}");
      const seen: Seen = { model: body.model, body, auth: req.headers["authorization"] };
      stats.seen.push(seen);
      const r = handler(seen, stats.hits);
      if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
      stats.inflight--;
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1/`, stats };
}

const ok = (over: Record<string, unknown> = {}, usage = { prompt_tokens: 10, completion_tokens: 20 }) => ({
  status: 200,
  headers: { "x-ratelimit-remaining-requests": "99", "x-ratelimit-limit-requests": "100" },
  body: {
    id: "x",
    model: "served-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello", ...over } }],
    usage,
  },
});

function make(url: string, tweak: (c: ReturnType<typeof defaultModelConfig>) => void = () => undefined) {
  const cfg = defaultModelConfig();
  cfg.providers["tokenfactory"]!.baseUrl = url;
  cfg.timeoutMs = 2000;
  tweak(cfg);
  const sleeps: number[] = [];
  const records: ModelCallRecord[] = [];
  const p = new OpenAICompatibleProvider({
    config: cfg,
    env: { NEBIUS_API_KEY: SECRET },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1,
    onCall: (r) => records.push(r),
  });
  return { p, sleeps, records, cfg };
}
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  role: "worker",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 500,
  ...over,
});
const ctx = { runId: "r1", taskId: "t1" };
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return e instanceof ModelError ? e.kind : `OTHER:${String(e)}`;
  }
};

describe("OpenAICompatibleProvider", () => {
  test("parses tool calls and keeps reasoning OUT of the history; served model may differ without being a fallback", async () => {
    const m = await mock(() =>
      ok(
        {
          content: null,
          reasoning_content: "let me think… private chain of thought",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_files", arguments: '{"paths":["a.py"]}' } }],
        },
        { prompt_tokens: 100, completion_tokens: 40, ...({ completion_tokens_details: { reasoning_tokens: 30 } } as object) } as never,
      ),
    );
    const { p } = make(m.url);
    const r = await p.complete(req({ tools: [{ type: "function", function: { name: "read_files", description: "d", parameters: { type: "object" } } }] }), ctx);
    assert.deepEqual(r.toolCalls.map((t) => [t.name, t.argsValid, t.args]), [["read_files", true, { paths: ["a.py"] }]]);
    assert.equal(r.reasoning, "let me think… private chain of thought");
    assert.equal(JSON.stringify(r.assistantMessage).includes("chain of thought"), false, "reasoning must not be replayable");
    assert.equal(r.assistantMessage.tool_calls?.[0]?.function.arguments, '{"paths":["a.py"]}');
    assert.deepEqual(r.usage, { promptTokens: 100, completionTokens: 40, reasoningTokens: 30 });
    assert.equal(r.requestedModel, SUPER);
    assert.equal(r.servedModel, "served-model");
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.rateLimit.remainingRequests, 99);
  });

  test("routes by role: model, temperature, forced tool choice and json_schema", async () => {
    const m = await mock(() => ok());
    const { p } = make(m.url);
    await p.complete(req({ role: "supervisor", responseSchema: { name: "plan", schema: { type: "object" } } }), ctx);
    await p.complete(
      req({ role: "worker", tools: [{ type: "function", function: { name: "propose_patch", description: "d", parameters: {} } }], toolChoice: { name: "propose_patch" } }),
      ctx,
    );
    const [sup, wrk] = m.stats.seen;
    assert.equal(sup?.model, SUPER);
    assert.equal(sup?.body.temperature, 0.2);
    assert.deepEqual(sup?.body.response_format, { type: "json_schema", json_schema: { name: "plan", schema: { type: "object" } } });
    assert.equal(wrk?.model, SUPER);
    assert.equal(wrk?.body.temperature, 0);
    assert.deepEqual(wrk?.body.tool_choice, { type: "function", function: { name: "propose_patch" } });
    assert.equal(sup?.auth, `Bearer ${SECRET}`);
  });

  test("429: waits EXACTLY the server's Retry-After (no jitter shortening), then succeeds", async () => {
    const m = await mock((_s, n) => (n === 1 ? { status: 429, headers: { "retry-after": "2" }, body: { error: { message: "slow down" } } } : ok()));
    const { p, sleeps } = make(m.url);
    const r = await p.complete(req(), ctx);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(r.retries, 1);
    assert.equal(m.stats.hits, 2);
  });

  test("429 forever: RATE_LIMITED after the bounded attempts, carrying retryAfterMs", async () => {
    const m = await mock(() => ({ status: 429, headers: { "retry-after": "1" }, body: { error: { message: "no" } } }));
    const { p } = make(m.url);
    try {
      await p.complete(req({ role: "supervisor" }), ctx);
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ModelError);
      assert.equal(e.kind, "RATE_LIMITED");
      assert.equal(e.retryAfterMs, 1000);
    }
    assert.equal(m.stats.hits, 3, "1 try + 2 retries, no more");
  });

  test("5xx is retried with backoff, then UNAVAILABLE", async () => {
    const m = await mock(() => ({ status: 503, body: {} }));
    const { p, sleeps } = make(m.url);
    assert.equal(await kind(p.complete(req({ role: "supervisor" }), ctx)), "UNAVAILABLE");
    assert.equal(m.stats.hits, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1]! > sleeps[0]!, "exponential backoff");
  });

  test("worker falls back to the NEXT model only on UNAVAILABLE, and says so", async () => {
    const m = await mock((s) => (s.model === SUPER ? { status: 503, body: {} } : ok()));
    const { p, records } = make(m.url);
    const r = await p.complete(req(), ctx);
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.requestedModel, SUPER, "what was asked for stays on record");
    assert.deepEqual(m.stats.seen.map((s) => s.model), [SUPER, SUPER, SUPER, LIGHTNING]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.fallbackUsed, true);
  });

  test("model-not-found falls back immediately, without retrying the missing model", async () => {
    const m = await mock((s) => (s.model === SUPER ? { status: 404, body: { error: { message: "model not found" } } } : ok()));
    const { p } = make(m.url);
    const r = await p.complete(req(), ctx);
    assert.equal(r.fallbackUsed, true);
    assert.deepEqual(m.stats.seen.map((s) => s.model), [SUPER, LIGHTNING]);
  });

  test("400 and 401 are not retried and never fall back; context overflow is classified", async () => {
    for (const [status, msg, want] of [
      [400, "bad schema", "BAD_REQUEST"],
      [401, "invalid key", "AUTH"],
      [400, "This model's maximum context length is 262144 tokens", "CONTEXT_EXCEEDED"],
    ] as const) {
      const m = await mock(() => ({ status, body: { error: { message: msg } } }));
      const { p } = make(m.url);
      assert.equal(await kind(p.complete(req(), ctx)), want);
      assert.equal(m.stats.hits, 1, `${status}: exactly one request`);
    }
  });

  test("timeout becomes TIMEOUT after bounded retries", async () => {
    const m = await mock(() => ({ ...ok(), delayMs: 400 }));
    const { p } = make(m.url, (c) => {
      c.timeoutMs = 60;
      c.maxRetries = 1;
    });
    assert.equal(await kind(p.complete(req({ role: "supervisor" }), ctx)), "TIMEOUT");
    assert.equal(m.stats.hits, 2);
  });

  test("invalid tool-call JSON is reported on the call, not thrown; non-JSON body is UNAVAILABLE", async () => {
    const m = await mock(() => ok({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "propose_patch", arguments: '{"path": "a.py", ' } }] }));
    const { p } = make(m.url);
    const r = await p.complete(req(), ctx);
    assert.deepEqual([r.toolCalls[0]?.argsValid, r.toolCalls[0]?.args], [false, null]);
    assert.equal(r.toolCalls[0]?.argumentsRaw, '{"path": "a.py", ');

    const bad = await mock(() => ({ raw: "<html>gateway</html>" }));
    assert.equal(await kind(make(bad.url).p.complete(req({ role: "supervisor" }), ctx)), "UNAVAILABLE");
  });

  test("the API key never appears in errors, records or recorded bodies", async () => {
    const m = await mock(() => ({ status: 500, body: { error: { message: `upstream echoed Authorization: Bearer ${SECRET}` } } }));
    const { p, records } = make(m.url);
    let msg = "";
    try {
      await p.complete(req({ role: "supervisor" }), ctx);
    } catch (e) {
      msg = String((e as Error).message);
    }
    assert.equal(msg.includes(SECRET), false);
    assert.equal(JSON.stringify(records).includes(SECRET), false);
  });

  test("a 4xx whose body echoes the credential is scrubbed from the error and the record", async () => {
    const m = await mock(() => ({ status: 400, body: { error: { message: `bad header Authorization: Bearer ${SECRET} rejected` } } }));
    const { p, records } = make(m.url);
    let msg = "";
    try {
      await p.complete(req({ role: "supervisor" }), ctx);
    } catch (e) {
      msg = String((e as Error).message);
    }
    assert.match(msg, /BAD_REQUEST/);
    assert.equal(msg.includes(SECRET), false, "error message leaked the key");
    assert.equal(JSON.stringify(records).includes(SECRET), false, "record leaked the key");
  });

  test("budget: max_tokens is clamped to what is left, then calls are refused BEFORE any request", async () => {
    const m = await mock(() => ok({}, { prompt_tokens: 40, completion_tokens: 20 }));
    const { p } = make(m.url);
    const budget = new BudgetManager({ maxTokens: 100 });
    await p.complete(req({ maxTokens: 500 }), { ...ctx, budget });
    assert.equal(m.stats.seen[0]?.body.max_tokens, 100, "first call may use up to the whole budget");
    await p.complete(req({ maxTokens: 500 }), { ...ctx, budget });
    assert.equal(m.stats.seen[1]?.body.max_tokens, 40, "60 already spent");
    assert.equal(await kind(p.complete(req(), { ...ctx, budget })), "BUDGET");
    assert.equal(m.stats.hits, 2, "the refused call never left the process");

    const calls = new BudgetManager({ maxCalls: 1 });
    await p.complete(req(), { ...ctx, budget: calls });
    assert.equal(await kind(p.complete(req(), { ...ctx, budget: calls })), "BUDGET");
    const late = new BudgetManager({ deadlineMs: Date.now() - 1 });
    assert.equal(await kind(p.complete(req(), { ...ctx, budget: late })), "BUDGET");
  });

  test("global concurrency cap is honored", async () => {
    const m = await mock(() => ({ ...ok(), delayMs: 40 }));
    const { p } = make(m.url, (c) => {
      c.maxConcurrency = 2;
    });
    await Promise.all(Array.from({ length: 6 }, () => p.complete(req(), ctx)));
    assert.equal(m.stats.hits, 6);
    assert.ok(m.stats.maxInflight <= 2, `max in flight was ${m.stats.maxInflight}`);
  });

  test("missing key is a CONFIG error that names the variables, not a request", async () => {
    const cfg = defaultModelConfig();
    const p = new OpenAICompatibleProvider({ config: cfg, env: {} });
    try {
      await p.complete(req(), ctx);
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ModelError && e.kind === "CONFIG");
      assert.match(e.message, /NEBIUS_API_KEY, NEBIUS_TOKEN, NEMOTRON_TOKEN/);
    }
  });
});

describe("journal recorder", () => {
  test("success and failure are both recorded with cost, tokens and key-free bodies", async () => {
    const j = Journal.open(mkdtempSync(join(tmpdir(), "mc-")), "r1");
    try {
      const m = await mock((_s, n) => (n === 1 ? ok({ reasoning: "hidden" }, { prompt_tokens: 1000, completion_tokens: 2000 }) : { status: 400, body: { error: { message: "nope" } } }));
      const cfg = defaultModelConfig();
      cfg.providers["tokenfactory"]!.baseUrl = m.url;
      const p = new OpenAICompatibleProvider({ config: cfg, env: { NEBIUS_API_KEY: SECRET }, sleep: async () => undefined, onCall: journalRecorder(j) });
      await p.complete(req({ role: "supervisor" }), ctx);
      assert.equal(await kind(p.complete(req({ role: "supervisor" }), ctx)), "BAD_REQUEST");

      const rows = j.listModelCalls();
      assert.equal(rows.length, 2);
      const [good, bad] = rows;
      assert.equal(good?.requestedModel, SUPER);
      assert.equal(good?.promptTokens, 1000);
      assert.equal(good?.completionTokens, 2000);
      // served-model price when known; "served-model" is not in the table → unknown, not zero
      assert.equal(good?.costUsd, null);
      assert.match(bad?.error ?? "", /BAD_REQUEST/);
      for (const blob of [good?.requestBlob, good?.responseBlob, bad?.requestBlob]) {
        assert.ok(blob);
        assert.equal(j.artifacts.get(blob!).toString().includes(SECRET), false);
      }
      const ev = j.listEvents().filter((e) => e.entity === "model_call");
      assert.deepEqual(ev.map((e) => e.toState), ["OK", "FAILED"]);
    } finally {
      j.close();
    }
  });

  test("cost uses the served model's price when it is known", async () => {
    const j = Journal.open(mkdtempSync(join(tmpdir(), "mc-")), "r1");
    try {
      const m = await mock(() => ({ ...ok({}, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), body: { ...ok().body, model: SUPER, usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } } }));
      const cfg = defaultModelConfig();
      cfg.providers["tokenfactory"]!.baseUrl = m.url;
      const p = new OpenAICompatibleProvider({ config: cfg, env: { NEBIUS_API_KEY: SECRET }, onCall: journalRecorder(j) });
      await p.complete(req({ role: "supervisor" }), ctx);
      assert.equal(j.listModelCalls()[0]?.costUsd, 0.3 + 0.9);
    } finally {
      j.close();
    }
  });
});
