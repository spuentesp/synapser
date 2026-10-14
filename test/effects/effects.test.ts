// Plan 13 §5 (G1–G6): hard gates on side effects, against REAL git and a REAL (local, bare) remote.
// The question each test answers: could the effect have happened WITHOUT the human decision it needs?

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EffectBroker } from "../../src/effects/broker.ts";
import { checkEffects, checkPolicyDocuments } from "../../src/effects/invariants.ts";
import { type Exec } from "../../src/effects/kinds.ts";
import { DEFAULT_POLICY, evaluate, type Policy, validatePolicy } from "../../src/effects/policy.ts";
import { Journal } from "../../src/journal/journal.ts";
import { decideApproval, readChallenge } from "../../src/orchestration/gates.ts";

const R = "run-effects";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Dev", "-c", "user.email=dev@example.com"];

describe("policy", () => {
  test("strictest matching rule wins; default is deny; globs apply to parameters", () => {
    const p: Policy = {
      version: 1, default: "deny",
      rules: [
        { id: "push-feature", kind: "git.push", params: { branch: "feature/*" }, decision: "ask" },
        { id: "push-any-ask", kind: "git.push", decision: "ask" },
        { id: "no-main", kind: "git.push", params: { branch: "main" }, decision: "deny" },
        { id: "read-ok", kind: "git.status", decision: "allow" },
      ],
    };
    assert.equal(evaluate(p, "git.push", { branch: "feature/x" }).decision, "ask");
    assert.deepEqual([evaluate(p, "git.push", { branch: "main" }).decision, evaluate(p, "git.push", { branch: "main" }).ruleId], ["deny", "no-main"]);
    assert.equal(evaluate(p, "git.status", {}).decision, "allow");
    assert.deepEqual([evaluate(p, "deploy.prod", {}).decision, evaluate(p, "deploy.prod", {}).ruleId], ["deny", null], "unknown kind: default deny");
    assert.equal(evaluate(DEFAULT_POLICY, "git.push", { branch: "x", force: true }).decision, "deny");
  });

  test("an unconditional allow on a destructive kind is refused at load time; bad documents are rejected whole", () => {
    const bad = validatePolicy({ version: 1, default: "deny", rules: [{ id: "oops", kind: "git.push", decision: "allow" }, { id: "x", kind: "Bad Kind", decision: "ask" }] });
    assert.ok(!bad.ok);
    assert.match(bad.errors.join("|"), /defeats the gate/);
    assert.match(bad.errors.join("|"), /kind must be/);
    assert.ok(validatePolicy({ version: 1, default: "deny", rules: [{ id: "ok", kind: "git.push", params: { branch: "feature/*" }, decision: "allow" }] }).ok);
  });
});

describe("effect broker with real git", () => {
  let dir: string;
  let repo: string;
  let bare: string;
  let journal: Journal;
  let policy: Policy;
  let clock = 1_000_000;
  let broker: EffectBroker;

  const mk = (over: { exec?: Exec; fetch?: typeof fetch } = {}) => {
    broker = new EffectBroker({
      journal, runId: R, repoRoot: repo, policy: () => policy, now: () => clock,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      identity: { name: "Synapser", email: "synapser@localhost" },
      ...over,
    });
    return broker;
  };
  const remoteRef = (b: string) => execFileSync("git", ["-C", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const remoteHas = (b: string) => {
    try {
      return remoteRef(b);
    } catch {
      return null;
    }
  };
  const approve = (id: string, over: Record<string, unknown> = {}) => {
    const rec = broker.status(id)!;
    return decideApproval(journal, R, { taskId: `effect:${id}`, planDigest: rec.digest, currentDigest: rec.digest, decision: "APPROVED", actor: "ana", channel: "cli", ...over } as never);
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fx-")));
    repo = join(dir, "repo");
    bare = join(dir, "origin.git");
    mkdirSync(repo);
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ...ID, "add", "-A");
    git(repo, ...ID, "commit", "-q", "-m", "base");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "origin", "main");
    journal = Journal.open(join(dir, "state"), R);
    policy = { version: 1, default: "deny", rules: [{ id: "ask-commit", kind: "git.commit", decision: "ask" }, { id: "ask-push", kind: "git.push", decision: "ask" }, { id: "no-force", kind: "git.push", params: { force: "true" }, decision: "deny" }] };
    mk();
  });
  afterEach(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const violations = () => [...checkEffects(journal), ...checkPolicyDocuments(journal)].map((v) => `${v.invariant}:${v.code}`);

  test("commit then push: nothing happens until a human decides; then exactly the approved thing, once (G1, G2, G4)", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    const c = await broker.request({ kind: "git.commit", params: { message: "add two", branch: "feature/x" }, requestedBy: "worker#1" });
    assert.ok(c.ok && c.state === "PENDING");
    assert.match(c.summary, /Commit 1 file\(s\) on branch "feature\/x": "add two"/);
    await broker.tick();
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "G1: nothing happened without a decision");
    assert.equal(broker.status(c.id)!.state, "PENDING");

    assert.deepEqual(approve(c.id), { ok: true });
    await broker.tick();
    const done = broker.status(c.id)!;
    assert.equal(done.state, "DONE");
    assert.equal(git(repo, "rev-parse", "HEAD"), (done.evidence as { commit: string }).commit);
    assert.equal(git(repo, "log", "-1", "--format=%an|%s"), "Synapser|add two");

    const p = await broker.request({ kind: "git.push", params: { branch: "feature/x" }, requestedBy: "worker#1" });
    assert.ok(p.ok && p.state === "PENDING");
    assert.match(p.summary, /push [0-9a-f]{10} to origin\/feature\/x/);
    await broker.tick();
    assert.equal(remoteHas("feature/x"), null, "the remote has nothing before the approval");
    approve(p.id);
    await broker.tick();
    await broker.tick(); // a second tick must not run it again
    assert.equal(broker.status(p.id)!.state, "DONE");
    assert.equal(remoteHas("feature/x"), git(repo, "rev-parse", "HEAD"), "the remote has EXACTLY the approved commit");
    assert.equal(journal.listEvents().filter((e) => e.entity === "effect" && e.entityId === p.id && e.toState === "EXECUTING").length, 1);
    assert.deepEqual(violations(), []);
  });

  test("G2: an approval is for ONE exact effect — the repository moving after the request makes it STALE and nothing is pushed", async () => {
    git(repo, "switch", "-q", "-c", "feature/y");
    const p = await broker.request({ kind: "git.push", params: { branch: "feature/y" }, requestedBy: "w" });
    assert.ok(p.ok && p.state === "PENDING");
    writeFileSync(join(repo, "b.txt"), "sneaky\n");
    git(repo, ...ID, "add", "-A");
    git(repo, ...ID, "commit", "-q", "-m", "sneaky change after the request");
    approve(p.id);
    await broker.tick();
    const r = broker.status(p.id)!;
    assert.equal(r.state, "STALE");
    assert.match(r.reason ?? "", /STALE_EFFECT/);
    assert.equal(remoteHas("feature/y"), null);
    assert.deepEqual(violations(), []);
  });

  test("an approval of one effect cannot be spent on another", async () => {
    git(repo, "switch", "-q", "-c", "feature/a");
    const a = await broker.request({ kind: "git.push", params: { branch: "feature/a" }, requestedBy: "w" });
    const b = await broker.request({ kind: "git.push", params: { branch: "feature/b" }, requestedBy: "w" });
    assert.ok(a.ok && b.ok);
    assert.notEqual(broker.status(a.id)!.digest, broker.status(b.id)!.digest);
    approve(a.id);
    // presenting A's digest for B's gate is refused: it is not B's digest
    const wrong = decideApproval(journal, R, { taskId: `effect:${b.id}`, planDigest: broker.status(a.id)!.digest, currentDigest: broker.status(b.id)!.digest, decision: "APPROVED", actor: "ana", channel: "cli" });
    assert.deepEqual(wrong, { ok: false, code: "STALE_DIGEST" });
    await broker.tick();
    assert.equal(broker.status(a.id)!.state, "DONE");
    assert.equal(broker.status(b.id)!.state, "PENDING");
    assert.equal(remoteHas("feature/b"), null);
  });

  test("G5: a DENIED effect has no channel at all — not even a human approval can run it; unknown kinds are denied", async () => {
    const f = await broker.request({ kind: "git.push", params: { branch: "main", force: true }, requestedBy: "w" });
    assert.ok(f.ok && f.state === "DENIED");
    assert.equal(f.ok && f.rule, "no-force");
    assert.equal(journal.listEvents().some((e) => e.entity === "approval" && e.entityId === `effect:${f.id}`), false, "no gate was even opened");
    const attempt = decideApproval(journal, R, { taskId: `effect:${f.id}`, planDigest: "x", currentDigest: "x", decision: "APPROVED", actor: "ana", channel: "cli" });
    assert.deepEqual(attempt, { ok: false, code: "NOT_PENDING" });
    await broker.tick();
    assert.equal(broker.status(f.id)!.state, "DENIED");

    const u = await broker.request({ kind: "deploy.prod", params: {}, requestedBy: "w" });
    assert.ok(u.ok && u.state === "DENIED");
    assert.deepEqual(violations(), []);
  });

  test("G3: over MCP the approval needs the code only the human channels can read; a bare agent cannot spend the gate", async () => {
    git(repo, "switch", "-q", "-c", "feature/m");
    const p = await broker.request({ kind: "git.push", params: { branch: "feature/m" }, requestedBy: "claude-code#s1" });
    assert.ok(p.ok);
    const rec = broker.status(p.id)!;
    const base = { taskId: `effect:${p.id}`, planDigest: rec.digest, currentDigest: rec.digest, decision: "APPROVED" as const, actor: "claude-code#s1", channel: "mcp" as const };
    assert.deepEqual(decideApproval(journal, R, base), { ok: false, code: "BAD_CHALLENGE" });
    assert.deepEqual(decideApproval(journal, R, { ...base, challenge: "NOPE12" }), { ok: false, code: "BAD_CHALLENGE" });
    await broker.tick();
    assert.equal(remoteHas("feature/m"), null);
    const code = readChallenge(journal, `effect:${p.id}`, rec.digest)!;
    assert.deepEqual(decideApproval(journal, R, { ...base, challenge: code }), { ok: true });
    await broker.tick();
    assert.equal(broker.status(p.id)!.state, "DONE");
    assert.equal(JSON.stringify(journal.listEvents()).includes(code), false, "the code is not in the ledger");
    assert.deepEqual(violations(), []);
  });

  test("a rule can restrict WHO may approve: an approval through another channel does not count", async () => {
    policy = { ...policy, rules: [{ id: "cli-only", kind: "git.push", decision: "ask", channels: ["cli"] }] };
    mk();
    git(repo, "switch", "-q", "-c", "feature/c");
    const p = await broker.request({ kind: "git.push", params: { branch: "feature/c" }, requestedBy: "w" });
    assert.ok(p.ok);
    approve(p.id, { channel: "ui" });
    await broker.tick();
    const r = broker.status(p.id)!;
    assert.equal(r.state, "REJECTED");
    assert.match(r.reason ?? "", /channel "ui" is not allowed/);
    assert.equal(remoteHas("feature/c"), null);
  });

  test("approvals expire: a decision given long ago does not authorise a late execution", async () => {
    git(repo, "switch", "-q", "-c", "feature/t");
    policy = { ...policy, rules: [{ id: "short", kind: "git.push", decision: "ask", ttlSeconds: 60 }] };
    mk();
    const p = await broker.request({ kind: "git.push", params: { branch: "feature/t" }, requestedBy: "w" });
    assert.ok(p.ok);
    // the approval is recorded at "real" time; the broker's clock is far ahead
    approve(p.id);
    clock = Date.now() + 10 * 60_000;
    await broker.tick();
    assert.equal(broker.status(p.id)!.state, "EXPIRED");
    assert.equal(remoteHas("feature/t"), null);
    clock = 1_000_000;
  });

  test("safety rails: bad params are refused, nothing-to-commit and credential-looking files never get committed", async () => {
    const bad = await broker.request({ kind: "git.push", params: { branch: "bad branch name!" }, requestedBy: "w" });
    assert.ok(!bad.ok && bad.code === "INVALID_PARAMS");

    const empty = await broker.request({ kind: "git.commit", params: { message: "nothing" }, requestedBy: "w" });
    assert.ok(empty.ok && empty.state === "FAILED");
    assert.match(broker.status(empty.id)!.reason ?? "", /NOTHING_TO_COMMIT/);

    writeFileSync(join(repo, ".env"), "TOKEN=secret\n");
    const sens = await broker.request({ kind: "git.commit", params: { message: "oops" }, requestedBy: "w" });
    assert.ok(sens.ok && sens.state === "FAILED");
    assert.match(broker.status(sens.id)!.reason ?? "", /SENSITIVE_PATH.*\.env/);
    assert.equal(git(repo, "log", "--oneline").split("\n").length, 1, "no commit was made");
  });

  test("gh.pr and http.request go through the same gate, with injected executors", async () => {
    policy = {
      version: 1, default: "deny",
      rules: [
        { id: "pr", kind: "gh.pr", decision: "ask" },
        { id: "hook", kind: "http.request", params: { url: "https://hooks.example.com/**" }, decision: "ask" },
      ],
    };
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => (calls.push(`${cmd} ${args.slice(0, 3).join(" ")}`), { code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" });
    const fetched: string[] = [];
    mk({ exec, fetch: (async (u: string) => (fetched.push(u), new Response("ok", { status: 202 }))) as unknown as typeof fetch });

    const pr = await broker.request({ kind: "gh.pr", params: { title: "Add two", body: "details", base: "main", head: "feature/x" }, requestedBy: "w" });
    const hook = await broker.request({ kind: "http.request", params: { method: "POST", url: "https://hooks.example.com/notify", body: "{}" }, requestedBy: "w" });
    const offList = await broker.request({ kind: "http.request", params: { method: "POST", url: "https://evil.example.org/x", body: "data" }, requestedBy: "w" });
    assert.ok(pr.ok && pr.state === "PENDING" && hook.ok && hook.state === "PENDING");
    assert.ok(offList.ok && offList.state === "DENIED", "a host the policy does not name is denied by default");
    await broker.tick();
    assert.deepEqual([calls.length, fetched.length], [0, 0], "nothing ran before the decisions");
    approve(pr.id);
    approve(hook.id);
    await broker.tick();
    assert.equal((broker.status(pr.id)!.evidence as { url: string }).url, "https://github.com/o/r/pull/7");
    assert.deepEqual(fetched, ["https://hooks.example.com/notify"]);
    assert.deepEqual(violations(), []);
  });

  test("the checkers are not vacuous: a hand-built ledger that violates G1, G2, G3, G5 and G6 is flagged", () => {
    const j = journal;
    j.tx((t) => {
      // G1: an `ask` effect that executed with no approval at all
      t.event(R, "effect", "ef-x1", null, "PENDING", { kind: "git.push", decision: "ask", digest: "D1", policy_hash: "H-missing", requested_by: "w" });
      t.event(R, "effect", "ef-x1", "PENDING", "EXECUTING", { by: "broker", digest: "D1" });
      // G2 + G3: approved for another digest, relayed over MCP with no challenge
      t.event(R, "effect", "ef-x2", null, "PENDING", { kind: "git.push", decision: "ask", digest: "D2", policy_hash: "H-missing", requested_by: "w" });
      t.event(R, "approval", "effect:ef-x2", "PENDING", "APPROVED", { plan_digest: "OTHER", actor: "agent", channel: "mcp" });
      t.event(R, "effect", "ef-x2", "PENDING", "EXECUTING", { by: "broker", digest: "D2" });
      // G5: denied, and yet it ran
      t.event(R, "effect", "ef-x3", null, "DENIED", { kind: "git.push", decision: "deny", digest: "", policy_hash: "H-missing", requested_by: "w" });
      t.event(R, "effect", "ef-x3", "DENIED", "EXECUTING", { by: "broker" });
    });
    const v = new Set(violations());
    for (const want of ["G1:EXECUTED_WITHOUT_APPROVAL", "G2:APPROVAL_FOR_ANOTHER_EFFECT", "G3:MCP_APPROVAL_WITHOUT_CHALLENGE", "G5:DENIED_EFFECT_HAD_A_PATH", "G6:POLICY_NOT_RECORDED"]) {
      assert.ok(v.has(want), `${want} not flagged: ${[...v].join(",")}`);
    }
  });
});
