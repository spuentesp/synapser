import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal } from "../../src/journal/journal.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { loadConfig } from "../../src/config/load.ts";
import { treeDigest } from "../../src/validation/snapshot.ts";
import { runAgentTrial } from "../../src/agents/trial.ts";

describe("agent trial isolation and audit (plan 14 Q3.4)", () => {
  let workspace: string;
  let state: string;
  let journal: Journal;
  let library: LibraryStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agent-trial-source-"));
    writeFileSync(join(workspace, "README.md"), "original\n");
    state = mkdtempSync(join(tmpdir(), "agent-trial-ledger-"));
    journal = Journal.open(state, "_server");
    library = new LibraryStore(state, journal);
  });

  afterEach(() => {
    journal.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("runs an installed process against the disposable copy and persists only the trial report", { timeout: 60_000 }, async () => {
    const profile = {
      id: "trial-generic", description: "trial adapter", role: "writer" as const, adapter: "generic-cli" as const,
      argv: [process.execPath, "-e", "process.stdout.write('trial completed')", "{prompt}"], parser: "plain" as const,
      timeoutMs: 60_000, tags: ["trial"], enabled: true,
    };
    const cfg = { ...loadConfig({ cwd: workspace }), workspace, stateDir: state, profiles: [profile], agentSkills: {} };
    const before = treeDigest(workspace);
    const result = await runAgentTrial({ cfg, library, serverJournal: journal, profileId: profile.id, input: { task: "Inspect the project and report readiness", timeLimitSeconds: 10 } });
    assert.equal(result.outcome, "SUCCEEDED", result.reason ?? JSON.stringify(result));
    assert.match(result.output ?? "", /trial completed/);
    assert.equal(result.networkIsolated, false);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(treeDigest(workspace), before, "the source workspace never changed");

    const event = journal.listEvents().find((item) => item.entity === "agent_trial");
    assert.ok(event);
    const detail = event.data as Record<string, unknown>;
    assert.equal(detail["profileId"], profile.id);
    assert.equal(detail["sourceDigest"], before);
    assert.equal(detail["timeLimitSeconds"], 10);
    assert.ok(typeof detail["outputBlob"] === "string");
    assert.match(journal.artifacts.get(detail["outputBlob"] as string).toString("utf8"), /trial completed/);
    assert.doesNotMatch(JSON.stringify(detail), /Inspect the project and report readiness/, "the task text is not copied into the durable event");
  });
});
