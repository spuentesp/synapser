// The whole point, end to end: a workflow whose acceptance includes PUBLISHING. Agents edit; Synapser
// commits and pushes only after the human decisions the policy requires — and never publishes work
// that is not accepted. Real executor, real Zoanthrope, real git, real (local) remote.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { checkChain } from "../../src/audit/invariants.ts";
import { checkEffects, checkPolicyDocuments } from "../../src/effects/invariants.ts";
import type { Policy } from "../../src/effects/policy.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { decideApproval, pendingGates } from "../../src/orchestration/gates.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { checkSameSnapshot, checkWorkflowDone } from "../../src/workflow/invariants.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

const OP: Actor = { id: "ana", role: "operator" };
const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }, { ...cli("w-readme", "edit-readme"), tags: ["docs"] }];
const COMMANDS = [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }];
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Dev", "-c", "user.email=dev@example.com"];

describe("workflow that ends in a published branch", () => {
  let dir: string;
  let ws: string;
  let bare: string;
  let state: string;
  let mgr: WorkflowManager;
  const policy: Policy = { version: 1, default: "deny", rules: [{ id: "ask-commit", kind: "git.commit", decision: "ask" }, { id: "ask-push", kind: "git.push", params: { branch: "feature/*" }, decision: "ask" }] };

  const build = (plan: Plan) => {
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(["imports"]), profileIds: new Set(["w-schema", "w-readme"]), pollMs: 20, effectTickMs: 20,
      policy: () => policy,
      effectEnv: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      effectIdentity: { name: "Synapser", email: "synapser@localhost" },
      engine: new ProductionEngine({
        workspaceRoot: ws, stateDir: state, commands: COMMANDS, profiles: PROFILES, planner: async () => plan, pollMs: 20,
        models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "x" })] })),
        knownUsdPerRun: { "w-schema": 0.01, "w-readme": 0.01 }, limits: { maxRepairRounds: 0, missionMs: 60_000 },
      }),
    });
    return mgr;
  };
  const input = () => ({
    title: "Mark the schema and publish it", description: "Mark the schema, make sure the package imports, and publish the change as a branch",
    conditions: [
      { id: "schema", statement: "schema was changed", checker: { kind: "diff", require: ["app/schema.py"] } },
      { id: "imports", statement: "package imports", checker: { kind: "command", commandId: "imports" } },
      { id: "committed", statement: "the change is committed on feature/schema", checker: { kind: "effect", effectKind: "git.commit", params: { message: "Mark the schema", branch: "feature/schema" } } },
      { id: "pushed", statement: "the branch is pushed", checker: { kind: "effect", effectKind: "git.push", params: { remote: "origin", branch: "feature/schema" } } },
    ],
  });
  const remoteTip = (b: string): string | null => {
    try {
      return execFileSync("git", ["-C", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const waitFor = async (fn: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-fx-")));
    ws = join(dir, "ws");
    bare = join(dir, "origin.git");
    state = join(dir, "state");
    cpSync(BASELINE, ws, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", ws]);
    git(ws, ...ID, "add", "-A");
    git(ws, ...ID, "commit", "-q", "-m", "baseline");
    git(ws, "remote", "add", "origin", bare);
    git(ws, "push", "-q", "origin", "main");
  });
  afterEach(async () => {
    await mgr?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("DONE requires the commit AND the push; each waits for a human; the remote ends with exactly the committed work", async () => {
    const m = build({ tasks: [{ id: "schema", objective: "Mark the schema file", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"], serves: ["schema", "imports"] }] });
    const c = m.create(input(), OP);
    assert.ok(c.ok);
    const id = c.id;
    m.start(id, OP);
    const j = m.journalOf(id)!;
    const decide = (key: string) => {
      const g = pendingGates(j).find((x) => x.key === key)!;
      return decideApproval(j, id, { taskId: key, planDigest: g.digest, currentDigest: g.digest, decision: "APPROVED", actor: "ana", channel: "cli" });
    };

    // 1) the work is done and verified, then Synapser ASKS to commit — and stops there
    assert.ok(await waitFor(() => pendingGates(j).some((g) => g.kind === "effect")), "the commit request reached the human");
    const first = pendingGates(j).find((g) => g.kind === "effect")!;
    assert.match(first.why, /Commit 1 file\(s\) on branch "feature\/schema": "Mark the schema" — M app\/schema\.py/);
    assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "main", "nothing committed before the decision");
    assert.equal(remoteTip("feature/schema"), null);
    assert.notEqual(m.status(id)!.state, "DONE");

    // 2) commit approved → it is made; then the push is asked, bound to that very commit
    assert.deepEqual(decide(first.key), { ok: true });
    assert.ok(await waitFor(() => pendingGates(j).some((g) => g.kind === "effect" && g.key !== first.key)), "the push request reached the human");
    const head = git(ws, "rev-parse", "HEAD");
    assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "feature/schema");
    const second = pendingGates(j).find((g) => g.kind === "effect")!;
    assert.match(second.why, new RegExp(`push ${head.slice(0, 10)} to origin/feature/schema`));
    assert.equal(remoteTip("feature/schema"), null, "still nothing remote");

    // 3) push approved → remote has exactly HEAD, and only now the workflow can be DONE
    assert.deepEqual(decide(second.key), { ok: true });
    await m.settled(id);
    const v = m.status(id)!;
    assert.equal(v.state, "DONE", v.reason ?? "");
    assert.equal(remoteTip("feature/schema"), head);
    assert.equal(remoteTip("main"), git(ws, "rev-parse", "main"), "main untouched");
    assert.deepEqual(v.conditions.map((x) => `${x.id}:${x.status}`), ["schema:SATISFIED", "imports:SATISFIED", "committed:SATISFIED", "pushed:SATISFIED"]);
    assert.equal(git(ws, "show", "--stat", "--format=", "HEAD").includes(".zoanthrope"), false, "Synapser's own files are not published");
    assert.deepEqual([...checkWorkflowDone(j, v.workflow), ...checkSameSnapshot(j), ...checkEffects(j), ...checkPolicyDocuments(j), ...checkChain(j)], []);
  });

  test("effects are NOT attempted while required conditions are unmet: unaccepted work is never published", async () => {
    // no task serves the diff condition, so it can never be satisfied
    const m = build({ tasks: [{ id: "docs", objective: "Touch only the readme file", scope: ["README.md"], criteria: ["c"], deps: [], tags: ["docs"], serves: ["imports"] }] });
    const c = m.create(input(), OP);
    assert.ok(c.ok);
    m.start(c.id, OP);
    await m.settled(c.id);
    const v = m.status(c.id)!;
    assert.equal(v.state, "FAILED");
    const j = m.journalOf(c.id)!;
    assert.equal(j.listEvents().some((e) => e.entity === "effect"), false, "no effect was even requested");
    const detail = v.conditions.find((x) => x.id === "pushed")!.detail ?? "";
    assert.match(detail, /not attempted: required condition\(s\) unmet \(schema, committed\)/);
    assert.equal(remoteTip("feature/schema"), null);
  });

  test("a REJECTED commit fails the workflow without publishing anything", async () => {
    const m = build({ tasks: [{ id: "schema", objective: "Mark the schema file", scope: ["app/schema.py"], criteria: ["c"], deps: [], tags: ["schema"], serves: ["schema", "imports"] }] });
    const c = m.create(input(), OP);
    assert.ok(c.ok);
    m.start(c.id, OP);
    const j = m.journalOf(c.id)!;
    assert.ok(await waitFor(() => pendingGates(j).some((g) => g.kind === "effect")));
    const g = pendingGates(j).find((x) => x.kind === "effect")!;
    decideApproval(j, c.id, { taskId: g.key, planDigest: g.digest, currentDigest: g.digest, decision: "REJECTED", actor: "ana", channel: "cli", reason: "not yet" });
    const t0 = Date.now();
    await m.settled(c.id);
    assert.ok(Date.now() - t0 < 10_000, "it ended promptly: the push was not even asked after the commit was rejected");
    assert.equal(m.status(c.id)!.state, "FAILED");
    assert.equal(remoteTip("feature/schema"), null);
    assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(m.journalOf(c.id)!.listEvents().filter((e) => e.entity === "effect" && e.fromState === null).length, 1, "only the commit was ever requested");
  });
});
