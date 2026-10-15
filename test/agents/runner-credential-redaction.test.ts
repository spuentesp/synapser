import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
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
  const cli = join(bin, "codex");
  writeFileSync(cli, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('leak.txt', process.env.TEST_PROVIDER_KEY);
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
    for (const blob of [row.stdoutBlob, row.stderrBlob, row.finalTextBlob, ...row.changes.flatMap((change) => [change.beforeBlob, change.afterBlob])]) {
      if (blob) assert.equal(journal.artifacts.get(blob).includes(Buffer.from(secret)), false);
    }
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
