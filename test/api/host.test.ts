import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type ApiServer, createApi } from "../../src/api/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// P15 IC4: the API answers only to its own host names. A page that rebinds its name to 127.0.0.1 sends another Host.

function raw(port: number, method: string, path: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the API answers only to its own host names (P15 IC4)", () => {
  let state: string;
  let ws: string;
  let mgr: WorkflowManager;
  let api: ApiServer;
  let port: number;
  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), "host-state-"));
    ws = mkdtempSync(join(tmpdir(), "host-ws-"));
    mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
    api = createApi({ stateDir: state, ssePollMs: 20, control: { manager: mgr } });
    port = await api.listen(0);
  });
  afterEach(async () => {
    await api.close();
    await mgr.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test("the session token is not handed to a rebound name, and the own names still get it", async () => {
    const rebound = await raw(port, "GET", "/api/session", `evil.example:${port}`);
    assert.equal(rebound.status, 421);
    assert.equal(rebound.body.includes(api.token), false);
    const own = await raw(port, "GET", "/api/session", `127.0.0.1:${port}`);
    assert.equal(own.status, 200);
    assert.equal(JSON.parse(own.body).token, api.token);
    assert.equal((await raw(port, "GET", "/api/session", `localhost:${port}`)).status, 200);
  });

  test("a write from a rebound name is refused before the token is even checked", async () => {
    const r = await raw(port, "POST", "/api/designer/check", `evil.example:${port}`, { origin: `http://evil.example:${port}`, "x-synapser-token": api.token, "content-type": "application/json" });
    assert.equal(r.status, 421);
  });
});
