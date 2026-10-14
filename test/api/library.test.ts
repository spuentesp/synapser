import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 14 Q2.6: /api/library is versioned. Reads are open; writes need the token and the same origin; an
// invalid document is refused whole, with every problem, and changes nothing.

const PROVIDER = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["LIBRARY_TEST_KEY"], models: [{ id: "m1", usdPer1MIn: 0.5, usdPer1MOut: 1.5 }] };

describe("API library (plan 14 Q2.6)", () => {
  let state: string;
  let ws: string;
  let sj: Journal;
  let lib: LibraryStore;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let base: string;
  let token: string;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "lib-api-state-"));
    ws = mkdtempSync(join(tmpdir(), "lib-api-ws-"));
    sj = Journal.open(state, "_server");
    lib = new LibraryStore(state, sj);
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr, library: lib, config: () => ({ ok: true }) } });
    base = `http://127.0.0.1:${await api.listen(0)}`;
    token = api.token;
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ok = (): Record<string, string> => ({ origin: base, "x-synapser-token": token });

  test("reads are open; writes need the token and the same origin; a malformed origin is refused, not a crash", async () => {
    const list = await call("GET", "/api/library");
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as any).entries, []);
    const noToken = await call("PUT", "/api/library/providers/local", PROVIDER, { origin: base });
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json() as any).error, "BAD_TOKEN");
    const foreign = await call("PUT", "/api/library/providers/local", PROVIDER, { origin: "http://evil.example", "x-synapser-token": token });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json() as any).error, "CROSS_ORIGIN");
    const malformed = await call("PUT", "/api/library/providers/local", PROVIDER, { origin: "null", "x-synapser-token": token });
    assert.equal(malformed.status, 403);
    assert.equal(lib.get("providers", "local"), null, "no refused write changed the library");
  });

  test("a valid document is stored and comes back; writing the same document again changes nothing", async () => {
    const put = await call("PUT", "/api/library/providers/local", PROVIDER, ok());
    assert.equal(put.status, 200);
    const written = await put.json() as any;
    assert.equal(written.changed, true);
    assert.equal(written.kind, "providers");
    assert.equal(written.id, "local");
    const again = await call("PUT", "/api/library/providers/local", PROVIDER, ok());
    assert.equal((await again.json() as any).changed, false);
    const one = await (await call("GET", "/api/library/providers/local")).json() as any;
    assert.equal(one.document.baseUrl, PROVIDER.baseUrl);
    assert.equal((await (await call("GET", "/api/library/providers")).json() as any).entries.length, 1);
  });

  test("an invalid document is refused whole, listing every problem, and nothing is stored", async () => {
    const bad = { ...PROVIDER, baseUrl: "http://remote.example/v1/", apiKeyEnv: ["literal-secret!"], models: [] };
    const r = await call("PUT", "/api/library/providers/local", bad, ok());
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "INVALID_LIBRARY_DOCUMENT");
    const text = body.errors.join("\n");
    assert.match(text, /must be https/);
    assert.match(text, /environment variable names/);
    assert.match(text, /models must be a non-empty array/);
    assert.equal((await call("GET", "/api/library/providers/local")).status, 404);
  });

  test("DELETE needs the token; a removed entry is gone", async () => {
    await call("PUT", "/api/library/providers/local", PROVIDER, ok());
    const noToken = await call("DELETE", "/api/library/providers/local", undefined, { origin: base });
    assert.equal(noToken.status, 401);
    assert.notEqual(lib.get("providers", "local"), null, "the refused delete changed nothing");
    assert.deepEqual(await (await call("DELETE", "/api/library/providers/local", undefined, ok())).json() as any, { removed: true });
    assert.equal((await call("GET", "/api/library/providers/local")).status, 404);
  });

  test("skills, agents and templates are each checked by their own rules", async () => {
    const skill = await call("PUT", "/api/library/skills/style", { name: "style", description: "d" }, ok());
    assert.equal(skill.status, 400);
    assert.match((await skill.json() as any).errors.join("\n"), /content must be a non-empty string/);

    const agentShape = await call("PUT", "/api/library/agents/w1", { description: "x", role: "boss", argv: "nope", parser: "nope", timeoutMs: 0, tags: [] }, ok());
    assert.equal(agentShape.status, 400);
    const shapeText = (await agentShape.json() as any).errors.join("\n");
    assert.match(shapeText, /role must be/);
    assert.match(shapeText, /argv must be an array/);
    assert.match(shapeText, /parser must be one of/);
    assert.match(shapeText, /timeoutMs must be a positive number/);

    const agentRules = await call("PUT", "/api/library/agents/w1", { description: "x", role: "writer", argv: ["claude", "-p"], parser: "plain", timeoutMs: 1000, tags: ["code"] }, ok());
    assert.equal(agentRules.status, 400, "the profile rules run once the shape is right");
    assert.match((await agentRules.json() as any).errors.join("\n"), /argv must contain \{prompt\}/);

    assert.equal((await call("PUT", "/api/library/templates/t1", [], ok())).status, 400, "a template must be an object");
    assert.equal((await call("PUT", "/api/library/templates/t1", { title: "Cambio acotado" }, ok())).status, 200, "templates have no schema before Q3.2");
  });

  test("an unknown kind is refused; a document id that does not match its path is refused; an id the store cannot hold is refused", async () => {
    assert.equal((await call("GET", "/api/library/widgets")).status, 404);
    assert.equal((await call("PUT", "/api/library/widgets/x", PROVIDER, ok())).status, 404);
    const mismatch = await call("PUT", "/api/library/providers/local", { ...PROVIDER, id: "other" }, ok());
    assert.equal(mismatch.status, 400);
    assert.match((await mismatch.json() as any).errors.join("\n"), /does not match local/);
    const badId = await call("PUT", "/api/library/templates/Bad%20Id", { title: "x" }, ok());
    assert.equal(badId.status, 400);
    assert.equal((await badId.json() as any).error, "INVALID_LIBRARY_ENTRY");
  });

  test("the connection test runs against the STORED endpoint and key; the key never reaches the response", async () => {
    const seen: { auth: string | undefined; path: string }[] = [];
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ auth: req.headers["authorization"], path: req.url ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url?.endsWith("/models") ? JSON.stringify({ data: [{ id: "m1" }] }) : JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as { port: number }).port;
    process.env["LIBRARY_TEST_KEY"] = "sk-library-secret";
    try {
      await call("PUT", "/api/library/providers/local", { ...PROVIDER, baseUrl: `http://127.0.0.1:${port}/v1/` }, ok());
      const r = await call("POST", "/api/library/providers/local/test", undefined, ok());
      assert.equal(r.status, 200);
      const body = (await r.json()) as { ok: boolean; error: string | null; provider: string; keyFrom: string | null };
      assert.equal(body.ok, true, body.error ?? "");
      assert.equal(body.provider, "local");
      assert.equal(body.keyFrom, "LIBRARY_TEST_KEY");
      assert.deepEqual(seen.map((s) => [s.auth, s.path]), [["Bearer sk-library-secret", "/v1/models"], ["Bearer sk-library-secret", "/v1/chat/completions"]]);
      assert.equal(JSON.stringify(body).includes("sk-library-secret"), false, "the key never reaches the response");
    } finally {
      delete process.env["LIBRARY_TEST_KEY"];
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  test("the connection test is a write: no token, no call; an unknown or non-provider target is refused", async () => {
    await call("PUT", "/api/library/providers/local", PROVIDER, ok());
    assert.equal((await call("POST", "/api/library/providers/local/test", undefined, { origin: base })).status, 401);
    assert.equal((await call("POST", "/api/library/providers/missing/test", undefined, ok())).status, 404);
    assert.equal((await call("POST", "/api/library/skills/x/test", undefined, ok())).status, 404);
    assert.equal((await call("GET", "/api/library/providers/local/test")).status, 404);
  });

  test("a stored provider whose key is not set reports it, and sends nothing", async () => {
    await call("PUT", "/api/library/providers/local", PROVIDER, ok());
    delete process.env["LIBRARY_TEST_KEY"];
    const body = (await (await call("POST", "/api/library/providers/local/test", undefined, ok())).json()) as { ok: boolean; keyFrom: string | null; error: string | null };
    assert.equal(body.ok, false);
    assert.equal(body.keyFrom, null);
    assert.equal(body.error, "no API key in environment (tried LIBRARY_TEST_KEY)");
  });

  test("without a library the routes do not exist", async () => {
    const bare = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr } });
    const url = `http://127.0.0.1:${await bare.listen(0)}`;
    try {
      assert.equal((await fetch(`${url}/api/library`)).status, 404);
    } finally {
      await bare.close();
    }
  });
});
