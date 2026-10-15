import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeRepo } from "../fixtures/repo.ts";

// Plan 18 E7 (H7.1): a client that knows only the protocol starts `synapser mcp` as a process and talks to it over stdio.
// The workspace is a throwaway repository; the state directory is throwaway too.
const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;

class StdioClient {
  readonly #child: ChildProcessWithoutNullStreams;
  #buf = "";
  readonly #waiting = new Map<number, (m: Record<string, unknown>) => void>();
  #id = 0;
  constructor(cwd: string) {
    this.#child = spawn(process.execPath, [CLI, "mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buf += chunk;
      for (let i = this.#buf.indexOf("\n"); i >= 0; i = this.#buf.indexOf("\n")) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const resolve = this.#waiting.get(msg["id"] as number);
        if (resolve) {
          this.#waiting.delete(msg["id"] as number);
          resolve(msg);
        }
      }
    });
  }
  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 20 s`)), 20_000);
      this.#waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }
  notify(method: string): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
  async close(): Promise<number | null> {
    this.#child.stdin.end();
    return new Promise((resolve) => this.#child.on("exit", (code) => resolve(code)));
  }
}

describe("H7.1 a stdio client drives synapser mcp as a process", () => {
  let repo: string;
  let config: string;
  let client: StdioClient;
  beforeEach(async () => {
    repo = makeRepo(21);
    config = mkdtempSync(join(tmpdir(), "e2e-mcp-cfg-"));
    writeFileSync(join(config, "synapser.config.json"), JSON.stringify({ workspace: repo, stateDir: join(config, "state") }));
    client = new StdioClient(config);
    // The protocol handshake every MCP client performs first.
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } });
    client.notify("notifications/initialized");
  });
  afterEach(async () => {
    await client.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  });

  test("the server answers tools/list with its contract's tools, and no configuration tool", async () => {
    const r = await client.request("tools/list");
    const names = ((r["result"] as { tools: { name: string }[] }).tools).map((t) => t.name);
    assert.equal(names.length, 18);
    assert.ok(names.includes("workflow_list"));
    assert.equal(names.some((n) => n.startsWith("config_")), false);
  });

  test("a real call returns an empty workflow list, and an unknown method is refused by the protocol", async () => {
    const list = await client.request("tools/call", { name: "workflow_list", arguments: {} });
    assert.ok(list["result"], JSON.stringify(list));
    const text = ((list["result"] as { content: { text: string }[] }).content[0]!).text;
    assert.deepEqual(JSON.parse(text), { workflows: [] });
    const bad = await client.request("no/such/method");
    assert.ok(bad["error"], "an unknown method gets an error answer");
  });
});
