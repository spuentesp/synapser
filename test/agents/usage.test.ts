// The extractors run against the REAL outputs captured by the 13 Oct spike (test/fixtures/cli).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseClaude, parseCodex, parseKimi, parseMimo } from "../../src/agents/usage.ts";

const fx = (n: string) => readFileSync(new URL(`../fixtures/cli/${n}`, import.meta.url), "utf8");

describe("usage extractors", () => {
  test("claude -p json: tokens, cache split, USD, model, turns", () => {
    const r = parseClaude(fx("claude.json"));
    assert.equal(r.outcome, "SUCCEEDED");
    assert.equal(r.finalText, "OK");
    assert.equal(r.usage.provenance, "reported");
    assert.deepEqual(
      [r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens],
      [2, 4, 8607, 20190],
    );
    assert.ok(r.usage.costUsd !== null && Math.abs(r.usage.costUsd - 0.0816647) < 1e-6);
    assert.deepEqual(r.usage.models, ["claude-sonnet-5-5"]);
    assert.equal(r.usage.turns, 1);
    assert.equal(r.permissionDenials, 0);
  });

  test("claude: an error result is FAILED with its subtype, never SUCCEEDED", () => {
    const bad = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage: { input_tokens: 1 } });
    const r = parseClaude(bad);
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.reason, "error_max_turns");
  });

  test("codex exec --json: tokens net of cache, NO usd (null, not 0), turn.completed decides success", () => {
    const r = parseCodex(fx("codex.jsonl"));
    assert.equal(r.outcome, "SUCCEEDED");
    assert.equal(r.finalText, "OK");
    assert.equal(r.usage.inputTokens, 17331 - 11264);
    assert.equal(r.usage.cacheReadTokens, 11264);
    assert.equal(r.usage.outputTokens, 5);
    assert.equal(r.usage.costUsd, null);
    assert.equal(r.usage.provenance, "reported");
    // no turn.completed → UNKNOWN; an error event → FAILED
    assert.equal(parseCodex('{"type":"thread.started","thread_id":"x"}\n').outcome, "UNKNOWN");
    assert.equal(parseCodex('{"type":"turn.failed","error":{"message":"boom"}}\n').outcome, "FAILED");
  });

  test("kimi: stdout has no usage; the session log does (provenance 'log')", () => {
    const r = parseKimi(fx("kimi.stream.jsonl"), { wireText: fx("kimi.wire.jsonl") });
    assert.equal(r.outcome, "SUCCEEDED");
    assert.equal(r.finalText, "OK");
    assert.equal(r.sessionId, "session_4c0239d3-4526-422c-b29e-9f0a821cd4c4");
    assert.equal(r.usage.provenance, "log");
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens], [25102, 33, 19456, 0]);
    assert.deepEqual(r.usage.models, ["xiaomi-token-plan-sgp/mimo-v2.6-pro"]);
    assert.equal(r.usage.costUsd, null);
  });

  test("kimi without a session log: outcome and usage stay UNKNOWN (nulls, not zeros)", () => {
    const r = parseKimi(fx("kimi.stream.jsonl"), { sessionsRoot: "/nonexistent" });
    assert.equal(r.outcome, "UNKNOWN");
    assert.equal(r.usage.provenance, "unknown");
    assert.equal(r.usage.inputTokens, null);
    assert.equal(r.finalText, "OK");
  });

  test("kimi stream-json carries the tool-call transcript: tool use is counted for the audit", () => {
    const r = parseKimi(fx("kimi.tools.stream.jsonl"), { sessionsRoot: "/nonexistent" });
    assert.deepEqual(r.toolUse, { Read: 2, Bash: 1, Edit: 1 });
    assert.equal(r.finalText, "Done. The comment line was appended at the very end.");
  });

  test("mimo: the 402 error event is FAILED even though the process exited 0", () => {
    const r = parseMimo(fx("mimo-error.jsonl"));
    assert.equal(r.outcome, "FAILED");
    assert.match(r.reason ?? "", /Insufficient account balance/);
    assert.match(r.reason ?? "", /402/);
    assert.equal(r.usage.provenance, "unknown");
  });

  test("garbage in: never throws, never claims success", () => {
    for (const p of [parseClaude, parseCodex, parseMimo, (s: string) => parseKimi(s, { sessionsRoot: "/nonexistent" })]) {
      const r = p("<<< not json >>>");
      assert.notEqual(r.outcome, "SUCCEEDED");
      assert.equal(r.usage.costUsd, null);
    }
  });
});
