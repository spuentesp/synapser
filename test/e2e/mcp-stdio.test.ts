import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeRepo } from "../fixtures/repo.ts";
import { StdioClient } from "./stdio-client.ts";

// Plan 18 E7 (H7.1): a client that knows only the protocol starts `synapser mcp` as a process and talks to it over stdio.
// The workspace is a throwaway repository; the state directory is throwaway too.


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
