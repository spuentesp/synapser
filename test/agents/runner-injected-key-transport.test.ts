import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { ProfileRegistry } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { Journal } from "../../src/journal/journal.ts";

test("runAgent delivers an injected Kimi key through bwrap stdin, never argv or config", async () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-key-transport-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const operatorHome = join(root, "operator-home");
  mkdirSync(workspace);
  mkdirSync(bin);
  mkdirSync(operatorHome);

  const key = "local-kimi-dummy-key-transport-only";
  const cli = join(bin, "kimi");
  writeFileSync(cli, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const config = readFileSync(join(process.env.HOME, ".kimi-code/config.toml"), "utf8");
writeFileSync("credential-probe.json", JSON.stringify({
  presentInEnvironment: process.env.LOCAL_Q19_KEY === ${JSON.stringify(key)},
  valueInArgv: process.argv.includes(${JSON.stringify(key)}),
  valueInConfig: config.includes(${JSON.stringify(key)}),
}));
console.log(JSON.stringify({ role: "assistant", content: "credential transport probe completed" }));
`);
  chmodSync(cli, 0o755);

  const journal = Journal.open(state, "kimi-key-transport");
  try {
    let finished = false;
    let sawStdinLauncher = false;
    const running = runAgent({
      profile: new ProfileRegistry().get("kimi-writer")!,
      adapter: KIMI_ADAPTER,
      prompt: "Inspect the injected local provider configuration.",
      workspaceRoot: workspace,
      runId: "kimi-key-transport",
      taskId: null,
      journal,
      generation: 1,
      envSource: {
        PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
        HOME: operatorHome,
        LOCAL_Q19_KEY: key,
      },
      provider: {
        id: "q19-local",
        baseUrl: "http://127.0.0.1:9",
        apiKeyEnv: "LOCAL_Q19_KEY",
        model: "synapser-q19-local-model",
        protocol: "anthropic",
      },
    }).finally(() => { finished = true; });

    const deadline = Date.now() + 5_000;
    while (!finished && Date.now() < deadline) {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const commandLine = readFileSync(`/proc/${entry}/cmdline`);
          if (commandLine.includes(Buffer.from("synapser-env-launcher"))) sawStdinLauncher = true;
          assert.equal(commandLine.includes(Buffer.from(key)), false, "dummy key must not appear in host-visible process arguments");
        } catch (error) {
          // A process may exit between enumerating /proc and opening cmdline.
          if (!["ENOENT", "EACCES", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const result = await running;
    assert.equal(sawStdinLauncher, true, "the real bwrap wrapper must use the stdin-only environment bridge");
    assert.equal(result.exitCode, 0, result.reason ?? "the probe CLI must exit successfully");
    assert.equal(result.networkIsolated, false, "this test makes no network request and does not claim egress isolation");
    const probe = result.changes.find((change) => change.path === "credential-probe.json");
    assert.ok(probe?.afterBlob);
    assert.deepEqual(JSON.parse(journal.artifacts.get(probe.afterBlob).toString()), {
      presentInEnvironment: true,
      valueInArgv: false,
      valueInConfig: false,
    });
    assert.equal(JSON.stringify(result).includes(key), false, "the dummy value must not be returned or journaled");
    assert.deepEqual(journal.listChildren(), []);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
