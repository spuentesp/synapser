import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "review-tools",
  enabled: true,
  origin: "https://example.invalid/mcp/review-tools",
  version: "1.4.2",
  command: "/opt/synapser/mcp/review-tools",
  args: ["--stdio", "--mode", "review"],
  artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "bin/review-tools" },
  expectedServer: { name: "review-tools", version: "1.4.2" },
  profiles: { "codex-writer": ["inspect_diff", "read_file"] },
  ...patch,
});

function load(raw: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-registry-"));
  const path = join(root, "synapser.config.json");
  writeFileSync(path, JSON.stringify({ workspace: root, stateDir: join(root, "state"), research: false, ...raw }));
  return loadConfig({ path });
}

function rejects(raw: object, pattern: RegExp) {
  assert.throws(() => load(raw), (error: unknown) => error instanceof ConfigError && pattern.test(error.errors.join("\n")));
}

describe("operator MCP process registry", () => {
  test("defaults to an empty registry and accepts a strict stdio entry with profile-scoped tools", () => {
    assert.deepEqual(load().mcpServers, []);
    const cfg = load({ mcpServers: [entry()] });
    assert.deepEqual(cfg.mcpServers, [entry()]);
  });

  test("accepts absolute file origins and explicit disabled entries", () => {
    const server = entry({ enabled: false, origin: "file:///opt/synapser/mcp/review-tools/manifest.json" });
    assert.deepEqual(load({ mcpServers: [server] }).mcpServers, [server]);
  });

  test("accepts a normalized content-addressed artifact entrypoint and rejects malformed pins", () => {
    assert.deepEqual(load({ mcpServers: [entry()] }).mcpServers[0]?.artifact, {
      digest: `sha256:${"a".repeat(64)}`, entrypoint: "bin/review-tools",
    });
    rejects({ mcpServers: [entry({ artifact: { digest: "not-a-digest", entrypoint: "bin/tool" } })] }, /sha256:<lowercase-hex>/);
    rejects({ mcpServers: [entry({ artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "../tool" } })] }, /normalized relative POSIX path/);
    rejects({ mcpServers: [entry({ artifact: { digest: `sha256:${"a".repeat(64)}`, entrypoint: "/tool" } })] }, /normalized relative POSIX path/);
  });

  test("requires enabled to be explicit, an absolute command, and an argv array", () => {
    rejects({ mcpServers: [entry({ enabled: undefined })] }, /enabled must be explicitly/);
    rejects({ mcpServers: [entry({ command: "node server.js" })] }, /command must be an absolute executable path/);
    rejects({ mcpServers: [entry({ args: "--stdio" })] }, /args must be an array/);
    rejects({ mcpServers: [entry({ args: ["--stdio\0--evil"] })] }, /args must be an array/);
    rejects({ mcpServers: [entry({ args: ["--api-key", "inline-secret"] })] }, /common credential marker/);
    rejects({ mcpServers: [entry({ args: ["--token", "inline-secret"] })] }, /common credential marker/);
    rejects({ mcpServers: [entry({ args: ["--authorization", "Bearer inline-secret"] })] }, /common credential marker/);
  });

  test("rejects non-HTTPS origins, URL credentials, and non-exact version declarations", () => {
    rejects({ mcpServers: [entry({ origin: "http://example.invalid/server" })] }, /origin must be an HTTPS or absolute file URI/);
    rejects({ mcpServers: [entry({ origin: "https://user:secret@example.invalid/server" })] }, /origin must be an HTTPS or absolute file URI/);
    rejects({ mcpServers: [entry({ origin: "https://example.invalid/server?token=secret" })] }, /origin must be an HTTPS or absolute file URI/);
    rejects({ mcpServers: [entry({ version: " 1.4.2 " })] }, /version must be a non-floating version label/);
    rejects({ mcpServers: [entry({ version: "latest" })] }, /version must be a non-floating version label/);
  });

  test("checks exact expected server identity and profile references", () => {
    rejects({ mcpServers: [entry({ expectedServer: { name: "review-tools" } })] }, /expectedServer.version must be an exact/);
    rejects({ mcpServers: [entry({ expectedServer: { name: "", version: "1.4.2" } })] }, /expectedServer.name must be an exact/);
    rejects({ mcpServers: [entry({ profiles: { "future-agent": ["inspect_diff"] } })] }, /unknown profile "future-agent"/);
  });

  test("rejects duplicate registry IDs, duplicate tools, and unknown or secret-bearing properties", () => {
    rejects({ mcpServers: [entry(), entry()] }, /id "review-tools" is duplicated/);
    rejects({ mcpServers: [entry({ profiles: { "codex-writer": ["inspect_diff", "inspect_diff"] } })] }, /duplicate tool name/);
    rejects({ mcpServers: [entry({ env: { API_KEY: "must-not-be-stored" } })] }, /env is not allowed/);
    rejects({ mcpServers: [entry({ apiKey: "must-not-be-stored" })] }, /apiKey is not allowed/);
    rejects({ mcpServers: [entry({ expectedServer: { name: "review-tools", version: "1.4.2", secret: "x" } })] }, /expectedServer.secret is not allowed/);
  });
});
