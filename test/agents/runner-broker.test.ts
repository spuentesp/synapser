// cli-oneshot runner + patch broker, with a fake agent CLI so no model and no subscription is used.
// The broker side runs against the REAL executor, journal and zoanthrope.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { integrateRun } from "../../src/agents/broker.ts";
import { type AgentProfile, ProfileRegistry, validateProfile } from "../../src/agents/profile.ts";
import { runAgent } from "../../src/agents/runner.ts";
import { Journal } from "../../src/journal/journal.ts";
import { type Env, makeEnv, RUN, T1, T2 } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { BASELINE } from "../executor/env.ts";

const FAKE = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;
const profile = (mode: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: `fake-${mode}`,
  description: "test double",
  role: "writer",
  argv: [process.execPath, FAKE, mode, "{prompt}"],
  parser: "codex-jsonl",
  timeoutMs: 20_000,
  tags: ["test"],
  enabled: true,
  ...over,
});

describe("runner (isolation + observation)", () => {
  let ws: string;
  let journal: Journal;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "run-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    journal = Journal.open(realpathSync(mkdtempSync(join(tmpdir(), "run-state-"))), RUN);
  });
  afterEach(() => journal.close());
  const run = (mode: string, over: Partial<AgentProfile> = {}, extra: Record<string, unknown> = {}) =>
    runAgent({ profile: profile(mode, over), prompt: "do the thing", workspaceRoot: ws, runId: RUN, taskId: "t1", journal, generation: 1, ...extra });

  test("the real workspace is untouched; the change set, usage and ledger row are exact", async () => {
    const before = readFileSync(join(ws, "README.md"), "utf8");
    const r = await run("write");
    assert.equal(r.outcome, "SUCCEEDED");
    assert.equal(readFileSync(join(ws, "README.md"), "utf8"), before, "isolation: the agent edited a copy");
    assert.equal(existsSync(join(ws, "tests/test_basic.py")), true);
    assert.equal(existsSync(join(ws, "app/new_mod.py")), false);

    assert.deepEqual(r.changes.map((c) => [c.path, c.op]), [["README.md", "modify"], ["app/new_mod.py", "create"], ["tests/test_basic.py", "delete"]]);
    assert.equal(journal.artifacts.get(r.changes[1]!.afterBlob!).toString(), "x = 1\n");
    assert.deepEqual([r.usage.inputTokens, r.usage.cacheReadTokens, r.usage.outputTokens, r.usage.reasoningTokens], [600, 400, 50, 10]);
    assert.equal(r.usage.costUsd, null);

    const [row] = journal.listAgentRuns();
    assert.equal(row?.profileId, "fake-write");
    assert.equal(row?.outcome, "SUCCEEDED");
    assert.equal(row?.usageProvenance, "reported");
    assert.equal(row?.baseDigest, r.baseDigest);
    assert.deepEqual(row?.changes.map((c) => c.path), ["README.md", "app/new_mod.py", "tests/test_basic.py"]);
    assert.equal(journal.artifacts.get(row!.promptBlob!).toString(), "do the thing");
    assert.deepEqual(row?.argv.slice(-1), ["{prompt}"], "the ledger stores the template; the prompt is a blob");
    assert.ok(journal.listEvents().some((e) => e.entity === "agent_run" && e.toState === "SUCCEEDED"));
    assert.deepEqual(journal.listChildren(), []);
  });

  test("REGRESSION: the recorded BASE is what the agent was given, even if the live file changes mid-run", async () => {
    const original = readFileSync(join(ws, "app/schema.py"), "utf8");
    const p = run("slow-edit-schema");
    setTimeout(() => writeFileSync(join(ws, "app/schema.py"), `${original}# human edit during the run\n`), 150);
    const r = await p;
    const c = r.changes.find((x) => x.path === "app/schema.py")!;
    assert.equal(journal.artifacts.get(c.beforeBlob!).toString(), original, "base = what the agent saw, not the live file");
    assert.equal(c.beforeDigest !== null && c.beforeDigest !== c.afterDigest, true);
    assert.equal(journal.artifacts.get(c.afterBlob!).toString().includes("human edit"), false);
  });

  test("exit code 0 with an error event is FAILED (the exit code is not evidence)", async () => {
    const r = await run("error-exit0", { parser: "mimo-json" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.outcome, "FAILED");
    assert.match(r.reason ?? "", /402/);
    assert.equal(journal.listAgentRuns()[0]?.outcome, "FAILED");
  });

  test("timeouts kill the whole group and record FAILED", async () => {
    const r = await run("hang", { timeoutMs: 400 });
    assert.equal(r.timedOut, true);
    assert.equal(r.outcome, "FAILED");
    assert.match(r.reason ?? "", /timed out/);
    assert.deepEqual(journal.listChildren(), []);
  });

  test("a non-zero exit with no success evidence is FAILED with the tool's own message (kimi -p --auto case)", async () => {
    const r = await run("write", { argv: [process.execPath, "-e", "console.error('error: Cannot combine --prompt with --auto.'); process.exit(1)", "{prompt}"] });
    assert.equal(r.outcome, "FAILED");
    assert.match(r.reason ?? "", /exit code 1: error: Cannot combine/);
  });

  test("a program that does not exist is a recorded failure, not a crash", async () => {
    const r = await run("write", { argv: ["definitely-not-a-real-cli", "{prompt}"] });
    assert.equal(r.outcome, "FAILED");
    assert.match(r.reason ?? "", /spawn failed/);
    assert.equal(journal.listAgentRuns().length, 1);
  });

  test("our credentials never reach a third-party CLI; HOME and PATH do", async () => {
    const r = await run("env", {}, {
      envSource: { PATH: process.env["PATH"], HOME: "/home/someone", NEBIUS_API_KEY: "SECRET-1", NEMOTRON_TOKEN: "SECRET-2", TAVILY_TOKEN: "SECRET-3", ANTHROPIC_API_KEY: "SECRET-4" },
    });
    assert.equal(r.outcome, "SUCCEEDED");
    const envFile = r.changes.find((c) => c.path === "env.txt")!;
    const env = JSON.parse(journal.artifacts.get(envFile.afterBlob!).toString()) as Record<string, string>;
    assert.equal(env["HOME"], "/home/someone");
    assert.ok(env["PATH"]);
    for (const k of ["NEBIUS_API_KEY", "NEMOTRON_TOKEN", "TAVILY_TOKEN", "ANTHROPIC_API_KEY"]) assert.equal(k in env, false, `${k} leaked`);
  });

  test("the CLI's own bookkeeping directories are not part of the change set", async () => {
    const r = await run("metadata");
    assert.deepEqual(r.changes.map((c) => c.path), ["app/real.py"]);
  });

  test("binary output is flagged unsupported instead of being mangled", async () => {
    const r = await run("binary");
    assert.deepEqual(r.changes.map((c) => [c.path, c.unsupported]), [["blob.bin", "BINARY"]]);
  });
});

describe("profiles", () => {
  test("validation: shell strings, missing prompt slot and write flags on advisors are refused", () => {
    assert.deepEqual(validateProfile(profile("write")), []);
    assert.ok(validateProfile(profile("x", { argv: ["sh -c rm", "{prompt}"] })).length > 0);
    assert.ok(validateProfile(profile("x", { argv: ["codex", "exec"] })).some((e) => /\{prompt\}/.test(e)));
    assert.ok(validateProfile(profile("x", { role: "advisor", argv: ["kimi", "-p", "{prompt}", "--auto"] })).length > 0);
    assert.ok(validateProfile(profile("x", { role: "advisor", argv: ["codex", "exec", "-s", "workspace-write", "{prompt}"] })).length > 0);
  });
  test("the built-in catalog is valid; disabled profiles stay listed but are never offered", () => {
    const reg = new ProfileRegistry();
    assert.ok(reg.list({ enabledOnly: true }).length >= 5);
    assert.equal(reg.get("mimo-writer")?.enabled, false);
    assert.equal(reg.list({ enabledOnly: true }).some((p) => p.id === "mimo-writer"), false);
    assert.deepEqual(reg.list({ role: "advisor", enabledOnly: true }).map((p) => p.id).sort(), ["claude-opus-advisor", "codex-advisor"]);
  });
  test("a disabled profile cannot be run", async () => {
    const reg = new ProfileRegistry();
    const j = Journal.open(realpathSync(mkdtempSync(join(tmpdir(), "s-"))), RUN);
    await assert.rejects(runAgent({ profile: reg.get("mimo-writer")!, prompt: "x", workspaceRoot: tmpdir(), runId: RUN, taskId: null, journal: j, generation: 1 }), /disabled/);
    j.close();
  });
});

describe("patch broker (worktree + broker)", () => {
  let env: Env;
  let inc1: number;
  let inc2: number;
  beforeEach(async () => {
    env = await makeEnv();
    inc1 = env.exec.beginSession(T1).incarnation;
    inc2 = env.exec.beginSession(T2).incarnation;
  });
  afterEach(async () => env.close());
  const go = (mode: string, over: Partial<AgentProfile> = {}) =>
    runAgent({ profile: profile(mode, over), prompt: "p", workspaceRoot: env.ws, runId: RUN, taskId: "t1", journal: env.journal, generation: env.lock.generation });

  test("a successful run lands through claims and digests as ONE settled action", async () => {
    const run = await go("edit-schema");
    const r = await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, run);
    assert.equal(r.status, "INTEGRATED", JSON.stringify(r));
    assert.match(env.read("app/schema.py"), /# edited by the agent/);
    assert.equal(r.receipt?.status, "SETTLED");
    assert.deepEqual(await env.zoo.listClaims(), []);
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });

  test("STALE_VIEW: the live file moved while the agent worked, so nothing is overwritten", async () => {
    const run = await go("edit-schema");
    env.write("app/schema.py", "# a human changed this meanwhile\n");
    const r = await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, run);
    assert.equal(r.status, "STALE_VIEW");
    assert.equal(env.read("app/schema.py"), "# a human changed this meanwhile\n");
    assert.deepEqual(await env.zoo.listClaims(), []);
  });

  test("scope is enforced on the whole change set: one out-of-scope file rejects ALL of it", async () => {
    const run = await go("outside-scope");
    const before = env.read("app/schema.py");
    const r = await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, run);
    assert.equal(r.status, "REJECTED");
    assert.match(r.detail ?? "", /OUT_OF_SCOPE/);
    assert.equal(env.read("app/schema.py"), before, "the in-scope half was not applied either");
    assert.equal(existsSync(join(env.ws, "secrets.txt")), false);
  });

  test("advisors, failed runs and unsupported changes are never integrated", async () => {
    const adv = await go("edit-schema", { role: "advisor" });
    assert.equal((await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, adv)).status, "NOT_INTEGRATED");
    const failed = await go("error-exit0", { parser: "mimo-json" });
    assert.equal((await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, failed)).status, "NOT_INTEGRATED");
    const bin = await go("binary");
    assert.equal((await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, bin)).status, "UNSUPPORTED_CHANGE");
    assert.equal(existsSync(join(env.ws, "blob.bin")), false);
  });

  test("two agents on the same file: one lands, the other is told it is stale — no lost update", async () => {
    // both start from the same base, in parallel, each in its own copy
    const [a, b] = await Promise.all([go("edit-schema"), runAgent({ profile: profile("edit-schema"), prompt: "p", workspaceRoot: env.ws, runId: RUN, taskId: "t2", journal: env.journal, generation: env.lock.generation })]);
    const ra = await integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, a);
    const rb = await integrateRun(env.exec, { taskId: "t2", incarnation: inc2 }, b);
    assert.equal(ra.status, "INTEGRATED");
    assert.equal(rb.status, "STALE_VIEW");
    assert.equal((env.read("app/schema.py").match(/# edited by the agent/g) ?? []).length, 1, "applied exactly once");
    assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
  });

  test("disjoint files from two agents both land", async () => {
    const a = await go("edit-schema");
    const b = await runAgent({ profile: profile("edit-client"), prompt: "p", workspaceRoot: env.ws, runId: RUN, taskId: "t2", journal: env.journal, generation: env.lock.generation });
    const [ra, rb] = await Promise.all([
      integrateRun(env.exec, { taskId: "t1", incarnation: inc1 }, a),
      integrateRun(env.exec, { taskId: "t2", incarnation: inc2 }, b),
    ]);
    assert.deepEqual([ra.status, rb.status], ["INTEGRATED", "INTEGRATED"]);
    assert.match(env.read("app/schema.py"), /edited by the agent/);
    assert.match(env.read("app/client.py"), /client edit/);
    void writeFileSync;
  });
});
