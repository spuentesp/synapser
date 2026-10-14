import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Plan 15 D1 and D7 (P15.4, P15.7). The token travels in an HttpOnly cookie and never in a JSON body. In adversarial mode
// the cookie is granted only after the one-time code that serve prints in the terminal; five wrong guesses close the door.

const PROVIDER = { protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["SESSION_TEST_KEY"], models: [{ id: "m1" }] };
const cookieFor = (token: string) => `synapser_session=${token}`;
const COOKIE_SET = (token: string) => new RegExp(`synapser_session=${token}; Path=/; HttpOnly; SameSite=Strict`);

async function start(trustMode: "operator" | "adversarial") {
  const state = mkdtempSync(join(tmpdir(), "session-state-"));
  const ws = mkdtempSync(join(tmpdir(), "session-ws-"));
  const sj = Journal.open(state, "_server");
  const lib = new LibraryStore(state, sj);
  const mgr = new WorkflowManager({
    stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: () => new Set(), pollMs: 20,
    engine: { run: async () => ({ status: "DONE", reason: null }) },
  });
  const api: ApiServer = createApi({
    stateDir: state, ssePollMs: 20, trustMode,
    control: { manager: mgr, library: lib, config: () => ({ ok: true }), libraryPolicy: () => ({ ...NO_LIBRARY_POLICY, providerKeyEnv: ["SESSION_TEST_KEY"] }) },
  });
  const base = `http://127.0.0.1:${await api.listen(0)}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", origin: base, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const close = async () => {
    await api.close();
    await mgr.close();
    sj.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  };
  return { api, call, close };
}

describe("operator mode: the token is a cookie, never a body (plan 15 D1)", () => {
  test("the page gets the cookie at once, and the body never names the token", async () => {
    const s = await start("operator");
    try {
      const r = await s.call("GET", "/api/session");
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.equal(text.includes(s.api.token), false, "the token is not in the body");
      assert.deepEqual(JSON.parse(text), { ok: true, mode: "operator" });
      assert.match(r.headers.get("set-cookie") ?? "", COOKIE_SET(s.api.token));
    } finally {
      await s.close();
    }
  });

  test("a write needs the cookie or the header, and the same origin", async () => {
    const s = await start("operator");
    try {
      assert.equal((await s.call("PUT", "/api/library/providers/p1", PROVIDER, { cookie: cookieFor(s.api.token) })).status, 200, "the cookie alone serves the page");
      assert.equal((await s.call("PUT", "/api/library/providers/p2", PROVIDER, { "x-synapser-token": s.api.token })).status, 200, "the header still serves tools");
      const none = await s.call("PUT", "/api/library/providers/p3", PROVIDER);
      assert.equal(none.status, 401);
      assert.equal(((await none.json()) as { error: string }).error, "BAD_TOKEN");
      const cross = await s.call("PUT", "/api/library/providers/p4", PROVIDER, { cookie: cookieFor(s.api.token), origin: "http://evil.example" });
      assert.equal(cross.status, 403, "a cross-site write is refused even with the cookie");
    } finally {
      await s.close();
    }
  });

  test("operator mode has no redemption route", async () => {
    const s = await start("operator");
    try {
      assert.equal((await s.call("POST", "/api/session/redeem", { code: "anything" })).status, 404);
    } finally {
      await s.close();
    }
  });
});

describe("adversarial mode: the cookie waits for the one-time code (plan 15 D7)", () => {
  test("without the code the page gets no cookie and no write", async () => {
    const s = await start("adversarial");
    try {
      const r = await s.call("GET", "/api/session");
      assert.deepEqual(JSON.parse(await r.text()), { ok: false, mode: "adversarial", needsCode: true });
      assert.equal(r.headers.get("set-cookie"), null, "no cookie before the code");
      assert.equal((await s.call("PUT", "/api/library/providers/p1", PROVIDER)).status, 401);
      assert.notEqual(s.api.sessionCode, null, "serve has a code to print");
    } finally {
      await s.close();
    }
  });

  test("the right code grants the cookie once; a second redemption finds nothing", async () => {
    const s = await start("adversarial");
    try {
      const code = s.api.sessionCode;
      assert.ok(code, "a code is pending");
      const r = await s.call("POST", "/api/session/redeem", { code });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("set-cookie") ?? "", COOKIE_SET(s.api.token));
      assert.equal((await s.call("PUT", "/api/library/providers/p1", PROVIDER, { cookie: cookieFor(s.api.token) })).status, 200, "the granted cookie writes");
      assert.equal((await s.call("POST", "/api/session/redeem", { code })).status, 401, "the code is one use");
      assert.equal(s.api.sessionCode, null, "the code is spent");
    } finally {
      await s.close();
    }
  });

  test("five wrong guesses close the door, even for the right code", async () => {
    const s = await start("adversarial");
    try {
      const code = s.api.sessionCode;
      assert.ok(code);
      for (let i = 0; i < 5; i++) assert.equal((await s.call("POST", "/api/session/redeem", { code: `wrong-${i}` })).status, 401);
      const closed = await s.call("POST", "/api/session/redeem", { code });
      assert.equal(closed.status, 429);
      assert.equal(((await closed.json()) as { error: string }).error, "TOO_MANY_ATTEMPTS");
      assert.equal(s.api.sessionCode, code, "the code is still unspent, but no longer usable");
    } finally {
      await s.close();
    }
  });

  test("a redemption from another site is refused before any guess counts", async () => {
    const s = await start("adversarial");
    try {
      const code = s.api.sessionCode;
      assert.equal((await s.call("POST", "/api/session/redeem", { code }, { origin: "http://evil.example" })).status, 403);
      assert.equal((await s.call("POST", "/api/session/redeem", { code })).status, 200, "the right page can still redeem it");
    } finally {
      await s.close();
    }
  });
});
