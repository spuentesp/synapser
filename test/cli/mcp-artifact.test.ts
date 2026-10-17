import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;

function makeWritable(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

test("operator CLI imports and pins a local MCP package without running it", () => {
  const dir = mkdtempSync(join(tmpdir(), "synapser-mcp-import-cli-"));
  const source = join(dir, "package");
  mkdirSync(source);
  writeFileSync(join(source, "server.cjs"), "process.exit(41);\n");
  writeFileSync(join(source, "dependency.cjs"), "module.exports = true;\n");
  writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));

  try {
    const result = spawnSync(process.execPath, [CLI, "--config", join(dir, "synapser.config.json"), "mcp", "artifact", "import", source, "server.cjs"], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { digest: string; entrypoint: string; note: string };
    assert.match(output.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(output.entrypoint, "server.cjs");
    assert.match(output.note, /host runtime/);
    assert.equal(lstatSync(join(dir, "state", "mcp-artifacts", output.digest.slice(7), "server.cjs")).isFile(), true);
    assert.equal(result.stderr.includes("41"), false, "import stores files but never executes the package");
  } finally {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator CLI rejects traversal entrypoints before creating an artifact store", () => {
  const dir = mkdtempSync(join(tmpdir(), "synapser-mcp-import-invalid-"));
  const source = join(dir, "package");
  mkdirSync(source);
  writeFileSync(join(source, "server.cjs"), "// server\n");
  writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
  try {
    const result = spawnSync(process.execPath, [CLI, "--config", join(dir, "synapser.config.json"), "mcp", "artifact", "import", source, "../server.cjs"], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: synapser mcp artifact import/);
    assert.equal(existsSync(join(dir, "state")), false);
  } finally {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
