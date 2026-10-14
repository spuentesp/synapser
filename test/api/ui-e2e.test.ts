// The UI in a REAL browser (headless Chromium over CDP): it renders the swarm from the API, and
// clicking "Approve" records an approval on the ledger with the actor. Skipped without a browser.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApi, type ApiServer } from "../../src/api/server.ts";
import { currentPlanDigest, requestApproval } from "../../src/orchestration/gates.ts";
import { buildScenario } from "../audit/scenario.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const findChrome = (): string | null => {
  const env = process.env["CHROME_BIN"];
  if (env && existsSync(env)) return env;
  const root = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium-"))) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(root, d, sub))) return join(root, d, sub);
  }
  return null;
};
const CHROME = findChrome();

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (v: unknown) => void>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
      if (msg.id !== undefined) this.#pending.get(msg.id)?.(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", bad, { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((ok) => {
      this.#pending.set(id, ok);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })) as { result: { value: T } };
    return r.result.value;
  }
  async waitFor(expr: string, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`Boolean(${expr})`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for: ${expr}`);
  }
  close(): void {
    this.#ws.close();
  }
}

describe("UI in a real browser", { skip: CHROME ? false : "no Chromium found (set CHROME_BIN)" }, () => {
  let env: Env;
  let api: ApiServer;
  let base: string;
  let chrome: ChildProcess;
  let cdp: Cdp;

  beforeEach(async () => {
    env = await makeEnv();
    await buildScenario(env);
    requestApproval(env.journal, RUN, "deploy", currentPlanDigest(env.journal), "ship the change");
    api = createApi({ stateDir: env.state, journals: new Map([[RUN, env.journal]]), ssePollMs: 30 });
    base = `http://127.0.0.1:${await api.listen(0)}`;
    const profile = mkdtempSync(join(tmpdir(), "chrome-prof-"));
    chrome = spawn(CHROME as string, ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl: string = await new Promise((ok, bad) => {
      let buf = "";
      chrome.stderr!.on("data", (c: Buffer) => {
        buf += c.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m) ok(m[1] as string);
      });
      setTimeout(() => bad(new Error("chrome did not start")), 15_000);
    });
    const port = new URL(wsUrl).port;
    const tab = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
  });
  afterEach(async () => {
    cdp?.close();
    chrome?.kill("SIGKILL");
    await api.close();
    await env.close();
  });

  test("renders the swarm, shows the gate, and Approve records the decision with the actor", async () => {
    await cdp.send("Page.navigate", { url: `${base}/#swarm` });
    await cdp.waitFor(`document.querySelectorAll('.card').length >= 3`);
    const titles = await cdp.eval<string[]>(`[...document.querySelectorAll('.card .title')].map(e => e.textContent)`);
    assert.ok(titles.length >= 3, titles.join(","));
    assert.equal(await cdp.eval<boolean>(`document.querySelector('.integrity').classList.contains('ok')`), true, "chain badge is green");
    assert.equal(await cdp.eval<string>(`document.querySelector('.nav .count')?.textContent`), "1", "one pending approval is advertised");

    // no script or style injection is possible through ledger text: the page has a strict CSP
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy");
    assert.match(csp ?? "", /default-src 'self'/);

    await cdp.eval(`document.querySelector('[data-view="approvals"]').click()`);
    await cdp.waitFor(`document.querySelector('[data-decide="APPROVED"]')`);
    await cdp.eval(`document.querySelector('#actor').value = 'e2e-tester'`);
    await cdp.eval(`document.querySelector('[data-decide="APPROVED"]').click()`);
    await cdp.waitFor(`document.querySelector('.empty') && document.querySelector('.empty').textContent.length > 0 && !document.querySelector('[data-decide]')`);

    const ev = env.journal.listEvents().filter((e) => e.entity === "approval" && e.entityId === "deploy");
    assert.deepEqual(ev.map((e) => e.toState), ["PENDING", "APPROVED"]);
    assert.equal((ev[1]!.data as { actor: string }).actor, "e2e-tester");
    assert.equal(await cdp.eval<string | null>(`document.querySelector('.nav .count')?.textContent ?? null`), null, "the badge clears");
  });

  test("hostile text in the ledger is rendered as text, never as markup", async () => {
    env.journal.tx((t) => t.event(RUN, "alert", "<img src=x onerror=window.__pwned=1>", null, "COST_UNKNOWN", { profile: "<script>window.__pwned=1</script>" }));
    await cdp.send("Page.navigate", { url: `${base}/#timeline` });
    await cdp.waitFor(`document.querySelectorAll('.table tbody tr').length > 3`);
    assert.equal(await cdp.eval<unknown>(`window.__pwned`), undefined);
    assert.equal(await cdp.eval<number>(`document.querySelectorAll('.view img, .view script').length`), 0);
    assert.match(await cdp.eval<string>(`document.querySelector('.view').textContent`), /<img src=x/);
  });
});
