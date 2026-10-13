// A recorded scenario on the real stack: native + CLI agents, a stale integration, a failed run.
import type { Env } from "../executor/env.ts";
import { RUN } from "../executor/env.ts";
import { BUILTIN_PROFILES, type AgentProfile } from "../../src/agents/profile.ts";
import { CliOneShotRunner, NativeLoopRunner } from "../../src/agents/adapters.ts";
import { AgentRunnerRegistry, runAndIntegrate } from "../../src/agents/port.ts";
import { call, lastTool, ScriptedModel } from "../agent/scripted.ts";

const FAKE = new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname;
export const cli = (id: string, mode: string, parser: AgentProfile["parser"] = "codex-jsonl"): AgentProfile => ({
  id, description: "double", role: "writer", adapter: "cli-oneshot", argv: [process.execPath, FAKE, mode, "{prompt}"], parser, timeoutMs: 20_000, tags: [], enabled: true,
});

export async function buildScenario(env: Env): Promise<{ nativeActionId: string }> {
  let nativeActionId = "";
  env.journal.tx((t) => {
    t.insertMission({ runId: RUN, objective: "Add discount support", repo: "workspace", baseSha: "n/a", planRevision: 1, limits: {} });
    for (const [id, objective, scope] of [
      ["t1", "Append a marker to the schema", ["app/billing.py", "app/schema.py"]],
      ["t2", "Edit the schema too", ["app/billing.py", "app/schema.py"]],
      ["t3", "Edit the client", ["app/client.py"]],
    ] as const) {
      t.insertTask({ runId: RUN, taskId: id, actorOwner: `${RUN}:${id}`, priority: 0, scope: [...scope], spec: { kind: "agent", objective, criteria: [`${id} is done`], context: ["shared contract"] }, planRevision: 1, deps: [] });
    }
  });

  const native = new ScriptedModel((m, n) => {
    const last = lastTool(m);
    if (n === 1) return { calls: [call("read_files", { paths: ["app/schema.py"] })] };
    if (n === 2) {
      const cur = String(last.files[0].content);
      return { calls: [call("replace_in_file", { path: "app/schema.py", old: cur.slice(-30), new: `${cur.slice(-30)}\n# native marker\n` }), call("apply_changes", {})] };
    }
    return { calls: [call("finish", { summary: "I appended a marker so the schema is documented" })] };
  });
  const registry = new AgentRunnerRegistry([new NativeLoopRunner(native), new CliOneShotRunner()]);
  const task = (id: string, scope: string[]) => ({ taskId: id, objective: `task ${id}`, scope, criteria: ["c"], planRevision: 1 });
  const base = { workspaceRoot: env.ws, runId: RUN, journal: env.journal, executor: env.exec, generation: env.lock.generation };

  // 1) native agent lands a change on the schema
  const r1 = await runAndIntegrate(registry, { ...base, profile: BUILTIN_PROFILES.find((p) => p.id === "nemotron-worker")!, task: task("t1", ["app/billing.py", "app/schema.py"]) });
  nativeActionId = r1.run.integration.mode === "direct" ? (r1.run.integration.actions[0]?.actionId ?? "") : "";
  // 2) a CLI agent worked from the OLD base of the same file → stale
  const stale = runAndIntegrate(registry, { ...base, profile: cli("cli-stale", "slow-edit-schema"), task: task("t2", ["app/billing.py", "app/schema.py"]) });
  env.write("app/schema.py", `${env.read("app/schema.py")}# human edit\n`);
  await stale;
  // 3) a CLI agent that lands cleanly on a different file
  await runAndIntegrate(registry, { ...base, profile: cli("cli-good", "edit-client"), task: task("t3", ["app/client.py"]) });
  // 4) a CLI run that fails (exit 0 + error event)
  await runAndIntegrate(registry, { ...base, profile: cli("cli-bad", "error-exit0", "mimo-json"), task: task("t3", ["app/client.py"]) });
  return { nativeActionId };
}
