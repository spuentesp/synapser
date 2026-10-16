// H9.3 deterministic fixture: a real Synapser server uses a local OpenAI-compatible endpoint
// that proposes one no-op task before the workflow's human approval condition.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const modelServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  for await (const _chunk of req) { /* consume request body */ }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "fixture-plan",
    choices: [{ message: { role: "assistant", content: JSON.stringify({ tasks: [{
      id: "fixture-check",
      objective: "Run the deterministic fixture agent before human review.",
      scope: ["README.md"],
      criteria: ["The fixture agent reports completion."],
      deps: [],
      gates: ["approval"],
      tags: ["ui-fixture"],
      serves: ["c1"],
      profile: "ui-fixture-agent",
      tier: "cheap",
    }] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});

await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("local model fixture failed to bind");

const dir = mkdtempSync(join(tmpdir(), "ui-workflow-fixture-"));
writeFileSync(join(dir, "README.md"), "before\n");
writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({
  workspace: dir,
  stateDir: join(dir, "state"),
  research: false,
  profiles: [],
  agents: [{
    id: "ui-fixture-agent",
    description: "Deterministic no-op agent for the H9.3 browser fixture",
    role: "writer",
    adapter: "generic-cli",
    argv: [process.execPath, new URL("../fixtures/fake-agent.mjs", import.meta.url).pathname, "edit-readme", "{prompt}"],
    parser: "plain",
    tier: "cheap",
    tags: ["ui-fixture"],
    timeoutMs: 10_000,
  }],
  providers: {
    "ui-fixture": {
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1/`,
      apiKeyEnv: ["UI_FIXTURE_KEY"],
      models: [{ id: "ui-fixture-model" }],
    },
  },
  roles: { supervisor: { provider: "ui-fixture", model: "ui-fixture-model", temperature: 0 } },
}));

const port = process.env["UI_PORT"] ?? "4231";
const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NEBIUS_|TAVILY_)/.test(key)));
const child = spawn(process.execPath, [cli, "serve", "--port", port], { cwd: dir, env: { ...env, UI_FIXTURE_KEY: "local-fixture-only" }, stdio: "inherit" });
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => {
  modelServer.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
