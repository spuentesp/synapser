import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const TOKEN = "config-put-test-operator-token-0123456789";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForApi(base: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try { if ((await fetch(`${base}/api/session`)).ok) return; } catch { /* server booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("serve did not start");
}

describe("operator config CLI", () => {
  let dir: string;
  let server: ChildProcess;
  let base: string;
  let env: NodeJS.ProcessEnv;
  let document: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "synapser-config-put-"));
    writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
    document = join(dir, "provider.json");
    writeFileSync(document, JSON.stringify({ protocol: "openai-compatible", baseUrl: "https://provider.example/v1/", apiKeyEnv: ["CONFIG_PUT_TEST_KEY"], models: [{ id: "config-put-model" }] }));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = { ...process.env, SYNAPSER_OPERATOR_TOKEN: TOKEN, SYNAPSER_API_URL: base };
    server = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { cwd: dir, env, stdio: "ignore" });
    await waitForApi(base);
  });
  afterEach(async () => {
    server.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes with the operator token; missing token and invalid documents leave config untouched", async () => {
    const path = join(dir, "synapser.config.json");
    const original = readFileSync(path, "utf8");
    const unauthenticated = await fetch(`${base}/api/config/providers/fixture`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: readFileSync(document, "utf8"),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json() as { error: string }).error, "BAD_TOKEN");

    const denied = await run(["config", "put", "providers", "fixture", document], dir, { ...env, SYNAPSER_OPERATOR_TOKEN: "" });
    assert.notEqual(denied.code, 0);
    assert.equal(readFileSync(path, "utf8"), original);

    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ protocol: "nonsense", models: [] }));
    const refused = await run(["config", "put", "providers", "fixture", invalid], dir, env);
    assert.notEqual(refused.code, 0);
    assert.equal(readFileSync(path, "utf8"), original);

    const applied = await run(["config", "put", "providers", "fixture", document], dir, env);
    assert.equal(applied.code, 0, applied.stderr);
    const loaded = await fetch(`${base}/api/config`).then((response) => response.json()) as { providers: Record<string, { models: { id: string }[] }> };
    assert.equal(loaded.providers["fixture"]?.models[0]?.id, "config-put-model");
    assert.equal(`${applied.stdout}${applied.stderr}`.includes(TOKEN), false);
  });
});
