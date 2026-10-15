import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { StdioClient } from "./stdio-client.ts";

// Plan 18 E7 (H7.3, H7.4): the configuration connector, as a client drives it. `synapser serve` runs with a throwaway
// operator file and a test token (a sentinel, not a credential). `synapser mcp-config` is started as a process and
// talks to it over stdio. A valid put changes the file and reads back through the loader; a refused put leaves the file
// byte-identical and is recorded in the change log without any key value.
const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const TOKEN = "e2e-operator-token-sentinel-0123456789abcdef";
const HOT = { protocol: "openai-compatible", baseUrl: "https://hot.example/v1/", apiKeyEnv: ["HOT_KEY"], models: [{ id: "hot-model" }] };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForApi(base: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${base}/api/session`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("synapser serve did not answer within 20 s");
}

describe("H7.3 and H7.4 the configuration connector writes the operator file, or refuses without a partial change", () => {
  let dir: string;
  let server: ChildProcess;
  let client: StdioClient;
  let file: string;
  let log: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "e2e-cfg-"));
    file = join(dir, "synapser.config.json");
    log = join(dir, "state", "config-changes.jsonl");
    writeFileSync(file, JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { cwd: dir, env: { ...process.env, SYNAPSER_OPERATOR_TOKEN: TOKEN }, stdio: "ignore" });
    await waitForApi(base);
    client = new StdioClient(dir, ["mcp-config"], { SYNAPSER_API_URL: base, SYNAPSER_OPERATOR_TOKEN: TOKEN });
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } });
    client.notify("notifications/initialized");
  });
  afterEach(async () => {
    await client.close();
    server.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (name: string, args: unknown) => {
    const r = await client.request("tools/call", { name, arguments: args });
    return r["result"] as { isError?: boolean; content: { text: string }[] };
  };
  const auditLines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);

  test("H7.4 a valid provider is written to the file and the loader reads it back", async () => {
    const before = readFileSync(file, "utf8");
    const r = await call("config_put_provider", { id: "hot", provider: HOT });
    assert.equal(r.isError, false, r.content[0]?.text);
    assert.notEqual(readFileSync(file, "utf8"), before, "the operator file changed");
    const loaded = loadConfig({ path: file });
    assert.equal(loaded.providers["hot"]?.baseUrl, HOT.baseUrl, "the loader reads the provider back");
    const last = auditLines().at(-1);
    assert.equal(last?.["outcome"], "applied");
    assert.equal(last?.["kind"], "providers");
  });

  test("H7.3 a refused provider leaves the operator file byte-identical and is logged as refused", async () => {
    const r = await call("config_put_provider", { id: "meta", provider: { ...HOT, baseUrl: "http://169.254.169.254/" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0]?.text ?? "", /400/);
    assert.equal(readFileSync(file, "utf8"), JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }), "not one byte changed");
    const last = auditLines().at(-1);
    assert.equal(last?.["outcome"], "refused");
    assert.ok(Array.isArray(last?.["problems"]) && (last?.["problems"] as string[]).length > 0, "the problems are recorded");
  });

  test("H7.3 no audit line carries a key value", async () => {
    await call("config_put_provider", { id: "hot", provider: { ...HOT, apiKeyEnv: ["HOT_KEY"] } });
    await call("config_put_provider", { id: "meta", provider: { ...HOT, baseUrl: "http://169.254.169.254/" } });
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.equal(/sk-[A-Za-z0-9]/.test(text), false, "no key-shaped value in the log");
  });
});
