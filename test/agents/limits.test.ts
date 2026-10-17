import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedAgentArgv } from "../../src/agents/limits.ts";

test("bounded CLI scopes can join only a generated workflow memory slice", () => {
  const argv = boundedAgentArgv(["/usr/bin/agent", "--version"], "synapser-agent-12345678-1234-1234-1234-123456789abc.scope", "synapser-run-abcdef12-3456-7890-abcd-ef1234567890.slice");
  assert.ok(argv.includes("--slice=synapser-run-abcdef12-3456-7890-abcd-ef1234567890.slice"));
  assert.ok(argv.includes("--property=MemoryMax=4294967296"));
  assert.throws(() => boundedAgentArgv(["/usr/bin/agent"], undefined, "user.slice; touch /tmp/pwned"), /invalid workflow systemd slice name/);
});
