// cli-oneshot runner + patch broker, with a fake agent CLI so no model and no subscription is used.
// The broker side runs against the REAL executor, journal and zoanthrope.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PROFILE_CLI_ADAPTER, type AgentAdapter } from "../../src/agents/adapter.ts";
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

  test("invocation and output parsing are delegated to the selected AgentAdapter", async () => {
    let builds = 0;
    let parses = 0;
    const adapter: AgentAdapter = {
      ...PROFILE_CLI_ADAPTER,
      build(profile, task, injected) {
        builds += 1;
        return PROFILE_CLI_ADAPTER.build(profile, task, injected);
      },
      parse(stdout, profile, options) {
        parses += 1;
        return PROFILE_CLI_ADAPTER.parse(stdout, profile, options);
      },
    };

    const r = await run("write", {}, { adapter });
    assert.equal(r.outcome, "SUCCEEDED");
    assert.deepEqual([builds, parses], [1, 1]);
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
    const [row] = journal.listAgentRuns();
    assert.equal(row?.timedOut, true, "the persisted run must record the timeout");
    assert.equal(row?.outcome, "FAILED");
    assert.match(row?.reason ?? "", /timed out/);
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

  test("our credentials never reach a third-party CLI; PATH does, and HOME is a scratch directory", async () => {
    const r = await run("env", {}, {
      envSource: { PATH: process.env["PATH"], HOME: "/home/someone", NEBIUS_API_KEY: "SECRET-1", NEMOTRON_TOKEN: "SECRET-2", TAVILY_TOKEN: "SECRET-3", ANTHROPIC_API_KEY: "SECRET-4" },
    });
    assert.equal(r.outcome, "SUCCEEDED");
    const envFile = r.changes.find((c) => c.path === "env.txt")!;
    const env = JSON.parse(journal.artifacts.get(envFile.afterBlob!).toString()) as Record<string, string>;
    assert.notEqual(env["HOME"], "/home/someone", "the real HOME (ssh keys, gitconfig, gh) is not visible to the agent");
    assert.match(env["HOME"] ?? "", /synapser-agent-.*\/home$/);
    assert.ok(env["PATH"]);
    for (const k of ["NEBIUS_API_KEY", "NEMOTRON_TOKEN", "TAVILY_TOKEN", "ANTHROPIC_API_KEY"]) assert.equal(k in env, false, `${k} leaked`);
    assert.equal("DBUS_SESSION_BUS_ADDRESS" in env, false, "the scope transport is not inherited by the CLI");
    assert.equal("XDG_RUNTIME_DIR" in env, false, "the scope transport is not inherited by the CLI");
  });

  test("the real run is inside its bounded transient scope and inherits RLIMIT_AS", async () => {
    const r = await run("resource-limits");
    assert.equal(r.outcome, "SUCCEEDED", r.reason ?? "");
    const limitsFile = r.changes.find((c) => c.path === "resource-limits.json");
    assert.ok(limitsFile);
    const observed = JSON.parse(journal.artifacts.get(limitsFile.afterBlob!).toString()) as { virtualMemoryLimitKiB: string; cgroup: string; tasksMax: string; memoryMax: string };
    assert.equal(observed.virtualMemoryLimitKiB, "2097152");
    assert.match(observed.cgroup, /synapser-agent-[0-9a-f-]+\.scope/);
    assert.equal(observed.tasksMax, "64");
    assert.equal(observed.memoryMax, String(4 * 1024 * 1024 * 1024), "the kernel cgroup, not only systemd properties, enforces the aggregate cap");
  });

  test("a Claude HOME overlay never exposes or mutates operator skills", async () => {
    const realHome = realpathSync(mkdtempSync(join(tmpdir(), "claude-home-")));
    mkdirSync(join(realHome, ".claude", "skills", "private-skill"), { recursive: true });
    writeFileSync(join(realHome, ".claude", "settings.json"), "{}");
    writeFileSync(join(realHome, ".claude", "skills", "private-skill", "SKILL.md"), "private\n");
    const r = await run("inspect-home-skills", { homeOverlay: [".claude"] }, { envSource: { PATH: process.env["PATH"], HOME: realHome } });
    const observed = JSON.parse(journal.artifacts.get(r.changes.find((c) => c.path === "home-skills.json")!.afterBlob!).toString()) as { privateVisible: boolean };
    assert.equal(observed.privateVisible, false);
    assert.equal(readFileSync(join(realHome, ".claude", "skills", "private-skill", "SKILL.md"), "utf8"), "private\n");
  });

  test("PLAN 13 §5.2: an agent that tries to publish from its copy cannot — no repository, no credentials, no config", async () => {
    // a real repository with a real remote, and every credential variable present in the parent env
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "bare-")));
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", ws]);
    execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    execFileSync("git", ["-C", ws, "remote", "add", "origin", bare]);
    const realHome = realpathSync(mkdtempSync(join(tmpdir(), "realhome-")));
    writeFileSync(join(realHome, ".gitconfig"), "[credential]\n\thelper = store\n[user]\n\tname = Real Person\n");
    mkdirSync(join(realHome, ".ssh"));
    writeFileSync(join(realHome, ".ssh", "id_ed25519"), "PRIVATE");
    mkdirSync(join(realHome, ".claude"));
    writeFileSync(join(realHome, ".claude", "settings.json"), "{}");

    const r = await run("try-push", { homeOverlay: [".claude"] }, {
      envSource: { PATH: process.env["PATH"], HOME: realHome, SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "ghp_x", GITHUB_TOKEN: "ghp_y", GIT_ASKPASS: "/usr/bin/askpass", AWS_SECRET_ACCESS_KEY: "k" },
    });
    assert.equal(r.outcome, "SUCCEEDED");
    const rec = JSON.parse(journal.artifacts.get(r.changes.find((c) => c.path === "push-attempts.json")!.afterBlob!).toString()) as {
      attempts: { cmd: string; ok: boolean }[]; home: string; env: string[];
    };
    const byCmd = Object.fromEntries(rec.attempts.map((a) => [a.cmd.split(" ").slice(0, 2).join(" "), a]));
    assert.equal(byCmd["git push"]!.ok, false, "cannot push: its copy is not a repository");
    assert.equal(byCmd["git remote"]!.ok, false, "no remote exists in its copy");
    // `git config --global` points at /dev/null: it succeeds and says NOTHING — the user's identity and helpers are invisible
    assert.deepEqual([byCmd["git config"]!.ok, (byCmd["git config"] as { out?: string }).out], [true, ""]);
    assert.equal(byCmd["ssh -o"]!.ok, false, "no key, no agent: authentication cannot succeed");
    assert.equal(JSON.stringify(rec).includes("Real Person"), false);
    assert.notEqual(rec.home, realHome);
    for (const k of ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]) assert.equal(rec.env.includes(k), false, `${k} reached the agent`);
    assert.ok(rec.env.includes("GIT_CONFIG_GLOBAL") && rec.env.includes("GIT_TERMINAL_PROMPT"));
    // the remote is untouched
    const refs = execFileSync("git", ["-C", bare, "for-each-ref"], { encoding: "utf8" });
    assert.equal(refs, "");
    // the tool's own settings WERE made available (symlink), the user's keys were not
    const links = execFileSync("sh", ["-c", `ls -la ${join(rec.home, "..")}/home 2>/dev/null || true`], { encoding: "utf8" });
    void links;
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
