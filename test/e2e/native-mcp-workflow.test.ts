import assert from "node:assert/strict";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BUILTIN_PROFILES } from "../../src/agents/profile.ts";
import { importMcpArtifact } from "../../src/mcp/artifact-store.ts";
import { nativeWorkerProfileIds, validateMcpServerRegistry } from "../../src/mcp/registry.ts";
import type { Plan } from "../../src/mission/plan.ts";
import { ScriptedModel, call } from "../agent/scripted.ts";
import { BASELINE } from "../executor/env.ts";
import { ProductionEngine } from "../../src/workflow/engine.ts";
import { type Actor, WorkflowManager } from "../../src/workflow/manager.ts";

const INITIATOR: Actor = { id: "mcp-composition-client", role: "initiator" };
const PROFILE = BUILTIN_PROFILES.find((profile) => profile.id === "nemotron-worker")!;
const PLAN: Plan = {
  tasks: [{
    id: "inspect",
    objective: "Use the approved local MCP inspection tool and record its result.",
    scope: ["mcp-report.md"],
    criteria: ["the report records the local MCP value"],
    deps: [],
    tags: ["review"],
    serves: ["mcp-report"],
    profile: PROFILE.id,
    kind: "write",
  }],
};

let workspace: string;
let stateDir: string;
let packageRoot: string;
let artifactRoot: string;
let manager: WorkflowManager | undefined;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "synapser-mcp-workflow-ws-")));
  cpSync(BASELINE, workspace, { recursive: true });
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "synapser-mcp-workflow-state-")));
  const packageDir = mkdtempSync(join(tmpdir(), "synapser-mcp-workflow-package-"));
  packageRoot = join(packageDir, "package");
  artifactRoot = join(stateDir, "mcp-artifacts");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "server.cjs"), [
    "let input = '';",
    "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const line = input.slice(0, i); input = input.slice(i + 1); const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workflow-inspector', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', description: 'Returns a local fixture value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }); else if (request.method === 'tools/call') reply(request.id, { structuredContent: { value: 'composed-local-result' }, content: [{ type: 'text', text: 'composed-local-result' }] }); else if (request.id !== undefined) reply(request.id, {}); } });",
  ].join("\n"));
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  const makeWritable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  };
  makeWritable(stateDir);
  makeWritable(join(packageRoot, ".."));
  for (const path of [workspace, stateDir, join(packageRoot, "..")]) rmSync(path, { recursive: true, force: true });
});

test("P19.8 composes a pinned operator-approved MCP tool through ProductionEngine and a workflow verifier", async () => {
  const artifact = importMcpArtifact(packageRoot, artifactRoot);
  const checkedRegistry = validateMcpServerRegistry([{
    id: "workflow-inspector",
    enabled: true,
    origin: "file:///tmp/workflow-inspector-fixture",
    version: "1.0.0",
    command: process.execPath,
    args: [],
    artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
    expectedServer: { name: "workflow-inspector", version: "1" },
    profiles: { [PROFILE.id]: ["inspect"] },
    nativeReadOnlyProfiles: { [PROFILE.id]: ["inspect"] },
  }], [PROFILE.id], nativeWorkerProfileIds([PROFILE]));
  if (!checkedRegistry.ok) throw new Error(checkedRegistry.errors.join("; "));

  const model = new ScriptedModel((_messages, turn) => {
    if (turn === 1) return { calls: [call("mcp_workflow-inspector__inspect", {})] };
    if (turn === 2) return { calls: [call("read_files", { paths: ["mcp-report.md"] })] };
    if (turn === 3) {
      const mcpMessage = _messages.find((message) => message.role === "tool" && message.content?.includes("UNTRUSTED_MCP_DATA"));
      assert.ok(mcpMessage?.content, "the native model must receive the MCP response as tool data");
      const body = JSON.parse(mcpMessage.content) as { result?: { structuredContent?: { value?: string } } };
      return { calls: [call("write_file", { path: "mcp-report.md", content: `Observed: ${body.result?.structuredContent?.value ?? "missing"}\n` })] };
    }
    if (turn === 4) return { calls: [call("apply_changes", {})] };
    return { calls: [call("finish", { summary: "Recorded the inspected MCP value." })] };
  });
  const engine = new ProductionEngine({
    workspaceRoot: workspace,
    stateDir,
    commands: [],
    profiles: [PROFILE],
    mcpServers: checkedRegistry.servers,
    models: () => model,
    planner: async () => PLAN,
    limits: { maxRepairRounds: 0, concurrency: 1, missionMs: 60_000 },
    pollMs: 10,
  });
  manager = new WorkflowManager({
    stateDir,
    workspaceRoot: workspace,
    commandIds: new Set(),
    profileIds: new Set([PROFILE.id]),
    engine,
    pollMs: 10,
  });

  const created = manager.create({
    title: "Inspect the approved local MCP",
    description: "Record the value returned by the approved local MCP inspection tool.",
    goals: ["mcp-report.md records the inspected value"],
    nonGoals: ["Do not request other tools or perform effects"],
    conditions: [{ id: "mcp-report", statement: "The report contains the inspected value", checker: { kind: "file", path: "mcp-report.md", assert: { contains: "composed-local-result" } } }],
  }, INITIATOR);
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(manager.start(created.id, INITIATOR).ok);
  await manager.settled(created.id);

  const view = manager.status(created.id)!;
  const failedTask = manager.journalOf(created.id)!.listEvents().find((event) => event.entity === "task" && event.toState === "FAILED");
  assert.equal(view.state, "DONE", `${view.reason ?? ""}${failedTask ? `: ${JSON.stringify(failedTask.data)}` : ""}`);
  assert.equal(view.conditions[0]?.status, "SATISFIED");
  assert.equal(readFileSync(join(workspace, "mcp-report.md"), "utf8"), "Observed: composed-local-result\n");
  const journal = manager.journalOf(created.id)!;
  assert.equal(journal.listEvents().filter((event) => event.entity === "mcp_tool_snapshot").length, 1);
  assert.equal(journal.listEvents().filter((event) => event.entity === "mcp_tool_call").length, 1);
  assert.equal(journal.listAgentRuns().some((run) => run.profileId === PROFILE.id && run.outcome === "SUCCEEDED"), true);
});
