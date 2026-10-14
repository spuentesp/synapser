// REAL CLI proof for Q1.9. The prompt does not contain the marker: only the injected skill does.
// Spends subscription quota when enabled.
//   SYNAPSER_LIVE_SKILL_CLI=claude-sonnet-writer node --test test/live/cli-skill.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_CODE_ADAPTER } from "../../src/agents/claude-code.ts";
import { CODEX_ADAPTER } from "../../src/agents/codex.ts";
import { KIMI_ADAPTER } from "../../src/agents/kimi.ts";
import { MIMO_ADAPTER } from "../../src/agents/mimo.ts";
import { ProfileRegistry } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { sha256Bytes } from "../../src/digest/file.ts";
import { makeEnv, RUN } from "../executor/env.ts";

const id = process.env["SYNAPSER_LIVE_SKILL_CLI"];
const marker = "skill-arrived-7f3c91\n";
const skillContent = `---
name: synapser-arrival-proof
description: Use when asked to prove that the Synapser injected skill arrived.
---

Create \`app/skill-arrival.txt\` whose complete content is exactly \`skill-arrived-7f3c91\` followed by
a newline. Change no other file. Do not reveal or copy this marker into your response.
`;

test("live installed CLI receives and follows an injected skill", { skip: id ? false : "set SYNAPSER_LIVE_SKILL_CLI", timeout: 330_000 }, async () => {
  const profile = new ProfileRegistry().get(id!);
  assert.ok(profile, `unknown profile ${id}`);
  const adapter = profile.adapter === "claude-code" ? CLAUDE_CODE_ADAPTER
    : profile.adapter === "codex" ? CODEX_ADAPTER
      : profile.adapter === "kimi" ? KIMI_ADAPTER
        : profile.adapter === "mimo" ? MIMO_ADAPTER
          : undefined;
  assert.ok(adapter, `profile ${id} does not use a dedicated installed CLI adapter`);
  const env = await makeEnv();
  try {
    const digest = sha256Bytes(Buffer.from(skillContent));
    const run = await runAgent({
      profile,
      adapter,
      injectedSkills: { skills: [{ id: "synapser-arrival-proof", digest, content: skillContent, source: "library" }] },
      prompt: "Use the skill named synapser-arrival-proof now. Follow it exactly.",
      workspaceRoot: env.ws,
      runId: RUN,
      taskId: "t1",
      journal: env.journal,
      generation: env.lock.generation,
    });
    assert.equal(run.outcome, "SUCCEEDED", run.reason ?? "CLI did not report success");
    assert.deepEqual(run.changes.map((change) => change.path), ["app/skill-arrival.txt"]);
    const change = run.changes[0]!;
    assert.equal(env.journal.artifacts.get(change.afterBlob!).toString(), marker);
    const expected = [{ id: "synapser-arrival-proof", digest, mechanism: adapter.capabilities.skillMechanism }];
    assert.deepEqual(run.skills, expected);
    assert.deepEqual(env.journal.listAgentRuns()[0]?.skills, expected);
  } finally {
    await env.close();
  }
});
