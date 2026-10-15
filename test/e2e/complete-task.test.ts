import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentProfile } from "../../src/agents/profile.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { decideApproval, readChallenge } from "../../src/orchestration/gates.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";
import { call, ScriptedModel } from "../agent/scripted.ts";
import { cli } from "../audit/scenario.ts";
import { BASELINE } from "../executor/env.ts";

// Plan 18 E7 (H7.2): a complete task. A workflow is created, started, its start gate approved by the operator with the
// code the operator was shown, and the run reaches DONE. The repository changes only inside the declared scope: the
// schema changes, the README (a non-goal) does not, and nothing else appears. The agents are the CLI fake, on the real
// executor and journal.
const OP: Actor = { id: "ana", role: "operator" };
const AGENT: Actor = { id: "claude-code#1", role: "initiator" };
const PROFILES: AgentProfile[] = [{ ...cli("w-schema", "edit-schema"), tags: ["schema"] }];
const COMMANDS = [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client"], timeoutMs: 20_000 }];
const WF = {
  title: "Mark the schema", description: "Change the schema file only",
  goals: ["the schema file is changed"],
  nonGoals: [{ statement: "do not touch the README", guard: { kind: "diff", forbid: ["README.md"] } }],
  conditions: [{ id: "schema", statement: "app/schema.py was changed", checker: { kind: "diff", require: ["app/schema.py"] } }],
};
const PLAN: Plan = {
  tasks: [{ id: "schema", objective: "Do the schema work", scope: ["app/schema.py"], criteria: ["schema done"], deps: [], tags: ["schema"], serves: ["schema"] }],
};

/** Every regular file under root, with its content, keyed by path relative to root. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    const path = join(d.parentPath, d.name);
    out.set(relative(root, path), readFileSync(path, "utf8"));
  }
  return out;
}

describe("H7.2 a complete task: created, started, its gate approved, DONE, and the change stays in scope", () => {
  let ws: string;
  let state: string;
  let mgr: WorkflowManager | undefined;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "task-ws-")));
    cpSync(BASELINE, ws, { recursive: true });
    state = realpathSync(mkdtempSync(join(tmpdir(), "task-state-")));
  });
  afterEach(async () => {
    await mgr?.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("the run reaches DONE after the gate, and only the declared file changed", async () => {
    const engine = new ProductionEngine({
      workspaceRoot: ws, stateDir: state, commands: COMMANDS, profiles: PROFILES,
      models: () => new ScriptedModel(() => ({ calls: [call("finish", { summary: "nothing to do" })] })),
      knownUsdPerRun: { "w-schema": 0.01 },
      planner: async () => PLAN,
      limits: { maxRepairRounds: 0, concurrency: 1, missionMs: 60_000 },
      pollMs: 20,
    });
    mgr = new WorkflowManager({
      stateDir: state, workspaceRoot: ws, commandIds: new Set(COMMANDS.map((c) => c.id)), profileIds: new Set(PROFILES.map((p) => p.id)),
      engine, startRequiresApproval: true, pollMs: 20,
    });
    const before = snapshot(ws);

    const created = mgr.create(WF, AGENT);
    assert.ok(created.ok, JSON.stringify(created));
    const id = created.id;
    assert.deepEqual(mgr.start(id, AGENT), { ok: true, state: "AWAITING_START" });
    assert.equal(mgr.status(id)!.state, "AWAITING_START", "the agent cannot start it by itself");

    // The operator's gate: the code is shown to the operator, and relayed back over the MCP channel.
    const j = mgr.journalOf(id)!;
    const digest = (j.listEvents().find((e) => e.entity === "approval")!.data as { plan_digest: string }).plan_digest;
    const code = readChallenge(j, "start", digest)!;
    const approved = decideApproval(j, id, { taskId: "start", planDigest: digest, currentDigest: digest, decision: "APPROVED", actor: OP.id, channel: "mcp", challenge: code });
    assert.deepEqual(approved, { ok: true });

    await mgr.settled(id).catch(() => undefined);
    for (let i = 0; i < 300 && mgr.status(id)!.state !== "DONE" && mgr.status(id)!.state !== "FAILED"; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(mgr.status(id)!.state, "DONE", mgr.status(id)!.reason ?? "");

    const after = snapshot(ws);
    // .zoanthrope/ is the coordinator's own state inside the workspace, not an agent's change: it is excluded by name.
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => !p.startsWith(".zoanthrope/") && before.get(p) !== after.get(p)).sort();
    assert.deepEqual(changed, ["app/schema.py"], "only the declared file changed");
    assert.match(after.get("app/schema.py")!, /edited by the agent/);
    assert.equal(after.get("README.md"), before.get("README.md"), "the non-goal held");
  });
});
