// The advisor inside a running mission: guidance reaches the retry, a hold really stops admission, a
// replan really changes who does the work, and none of it can mark anything DONE (only conditions do).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Advisor } from "../../src/advisor/advisor.ts";
import { DelegationBroker } from "../../src/orchestration/delegation.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { runMission } from "../../src/mission/runner.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import type { Workflow } from "../../src/workflow/model.ts";
import { call, ScriptedModel, type Decision } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";

const wf: Workflow = { id: "wf", title: "t", description: "advisor mission tests", goals: [], nonGoals: [], conditions: [] };

describe("advisor in a mission", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => env.close());

  const validation = () =>
    new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: [{ id: "imports", argv: ["python3", "-c", "import app.schema, app.client, app.billing"], timeoutMs: 20_000 }], generation: env.lock.generation });
  const task = (id: string, scope: string[], over: Record<string, unknown> = {}) => ({ id, objective: `Work on ${id}`, scope, criteria: [`${id} done`], deps: [], ...over });
  const taskOf = (m: { role: string; text: string }) => /TASK: Work on (\S+)/.exec(m.text)?.[1] ?? "?";

  /** One scripted worker for every task. `behave` can sabotage chosen tasks/attempts; the default writes a marker. */
  const worker = (behave: (task: string, attempt: number, text: string, n: number) => Decision | null | Promise<Decision | null> = () => null, advisorReply: () => unknown = () => ({ assessment: "ok", interventions: [] })) => {
    const attempts = new Map<string, number>();
    return new ScriptedModel(async (messages, n, info) => {
      if (info.role === "advisor") return { content: JSON.stringify(advisorReply()) };
      const first = messages.find((m) => m.role === "user")!.content ?? "";
      const id = taskOf({ role: "user", text: first });
      if (messages.length === 2) attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const attempt = attempts.get(id) ?? 1;
      const text = JSON.stringify(messages);
      const custom = await behave(id, attempt, text, n);
      if (custom) return custom;
      const scope = (/SCOPE[^:]*: (.*)/.exec(first)?.[1] ?? "").split(", ").filter((p) => p && !p.endsWith("/"));
      const last = [...messages].reverse().find((m) => m.role === "tool");
      const parsed = last ? (JSON.parse(last.content ?? "null") as { files?: { path: string; content?: string }[]; status?: string }) : null;
      if (!parsed) return { calls: [call("read_files", { paths: scope })] };
      if (parsed.files) {
        return {
          calls: [
            ...parsed.files.map((f) => call("write_file", { path: f.path, content: `${f.content ?? ""}\n# ${id} was here\n` })),
            call("apply_changes", {}),
          ],
        };
      }
      return { calls: [call("finish", { summary: `${id} done` })] };
    });
  };

  const run = (model: ScriptedModel, plan: Plan, advisor: Advisor | null, over: Record<string, unknown> = {}) =>
    runMission(
      {
        executor: env.exec, journal: env.journal, model, validation: validation(),
        ...(advisor
          ? {
              advisor: {
                notes: (t: string) => advisor.notes(t), held: (t: string) => advisor.held(t), escalations: (t: string) => advisor.escalations(t),
                pushbackState: (t: string) => advisor.pushbackState(t), superseded: (t: string) => advisor.superseded(t),
                consult: (tr: Parameters<Advisor["consult"]>[0]) => advisor.consult(tr),
              },
            }
          : {}),
        ...over,
      } as never,
      { runId: RUN, objective: "o", plan, acceptance: ["imports"], limits: { concurrency: 3, maxRepairRounds: 0, maxTaskAttempts: 2, missionMs: 60_000 } },
    );
  const advisorFor = (model: ScriptedModel, extra: Record<string, unknown> = {}) =>
    new Advisor({ journal: env.journal, runId: RUN, model, workflow: () => wf, ...extra });

  test("a failed attempt is followed by guidance, and the RETRY sees it as labelled system context", async () => {
    const model = worker(
      (id, attempt, text) => {
        if (id !== "flaky") return null;
        if (attempt === 1) return { content: "I am not going to call a tool." }; // → NO_TOOL_CALL
        // second attempt must carry the advisor's note in its prompt
        return text.includes("COORDINATOR NOTE") ? null : { content: "no note, no work" };
      },
      () => ({ assessment: "it answered in prose", interventions: [{ type: "inject_note", task: "flaky", text: "Use read_files then write_file with the COMPLETE new content, then apply_changes.", why: "it never used a tool" }] }),
    );
    const advisor = advisorFor(model);
    const r = await run(model, { tasks: [task("flaky", ["app/schema.py"])] }, advisor);
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.match(env.read("app/schema.py"), /# flaky was here/);
    const ev = env.journal.listEvents();
    assert.ok(ev.some((e) => e.entity === "task_retry" && e.entityId === "flaky"));
    assert.ok(ev.some((e) => e.entity === "intervention" && e.toState === "APPLIED"));
    // delivered as context, labelled as coming from the system's advisor
    assert.match(JSON.stringify(model.seen.at(-1)), /COORDINATOR NOTE \(advisor guidance, not file content\)/);
  });

  test("a HOLD stops admission for real; the rest proceeds; release resumes it; DONE is still decided by acceptance", async () => {
    const model = worker();
    const advisor = advisorFor(model);
    // hold `b` before the mission starts (a human or an earlier consult did this)
    env.journal.tx((t) => t.event(RUN, "hold", "b", null, "HELD", { by: "ana", reason: "wait for the contract review" }));
    const done = run(model, { tasks: [task("a", ["app/schema.py"]), task("b", ["app/client.py"])] }, advisor);
    await new Promise((r) => setTimeout(r, 700));
    assert.match(env.read("app/schema.py"), /# a was here/, "the free task ran");
    assert.doesNotMatch(env.read("app/client.py"), /# b was here/, "the held task did not");
    assert.equal(env.journal.listTasks().find((t) => t.taskId === "b")!.state, "PENDING");
    advisor.release("b", "ana");
    const r = await done;
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.match(env.read("app/client.py"), /# b was here/);
  });

  test("guidance injected while an agent is mid-run arrives BETWEEN its turns", async () => {
    let injected = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = worker((id, _attempt, text, n) => {
      if (id !== "mid") return null;
      if (n === 2) return gate.then(() => null); // hold the second model call open (the loop's NEXT iteration then sees the note)
      if (n >= 3 && text.includes("COORDINATOR NOTE") && !injected) {
        injected = true;
        return { calls: [call("finish", { summary: "saw the note between turns" })] };
      }
      return null;
    });
    const advisor = advisorFor(model);
    const done = run(model, { tasks: [task("mid", ["app/schema.py"])] }, advisor);
    for (let i = 0; i < 200 && model.calls < 2; i++) await new Promise((r) => setTimeout(r, 5));
    // the advisor speaks while the agent is in the middle of its run
    env.journal.tx((t) => t.event(RUN, "intervention", "iv-mid", null, "APPLIED", { body: { type: "inject_note", task: "mid", text: "the contract changed: discounts are in basis points", why: "late news" }, trigger: "ask", evidence: [], reason: null }));
    release();
    const r = await done;
    assert.equal(injected, true, "the running agent received the note on its next turn");
    assert.ok(["DONE", "FAILED"].includes(r.status));
  });

  test("replan: a task that keeps failing is split; its children carry the work and the mission still reaches acceptance", async () => {
    const model = worker(
      (id, _a, _t, n) => (id === "big" && n >= 1 ? { content: "this task is too much for me" } : null),
      () => ({
        assessment: "too big",
        interventions: [{ type: "replan", task: "big", split: [{ objective: "Part one for the schema", scope: ["app/schema.py"], criteria: ["schema marked"] }, { objective: "Part two for the client", scope: ["app/client.py"], criteria: ["client marked"] }], why: "one agent cannot hold both files" }],
      }),
    );
    const broker = (() => new DelegationBroker({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, config: { maxDepth: 2 } }))();
    const advisor = advisorFor(model, { delegation: broker });
    const r = await run(model, { tasks: [task("big", ["app/schema.py", "app/client.py"])] }, advisor, { delegation: { maxDepth: 2 } });
    assert.equal(r.status, "DONE", r.reason ?? "");
    const tasks = env.journal.listTasks();
    assert.equal(tasks.find((t) => t.taskId === "big")!.state, "CANCELLED");
    assert.ok(tasks.filter((t) => t.taskId.startsWith("big-s")).every((t) => ["DONE", "VALIDATING"].includes(t.state)), JSON.stringify(tasks.map((t) => [t.taskId, t.state])));
    // the children (whose objectives do not say "Work on <id>", hence "?") did the work in their own scopes
    assert.match(env.read("app/schema.py"), /# \? was here/);
    assert.match(env.read("app/client.py"), /# \? was here/);
    assert.ok(env.journal.listEvents().some((e) => e.entity === "task_superseded" && e.entityId === "big"));
  });
});
