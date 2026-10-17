// Plan 18 E9 (H9.1): starts `synapser serve` on a port chosen by the test run, with a throwaway workspace and state.
// Playwright starts it as its web server and stops it when the run ends; the child is stopped with the parent.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importArtifact } from "../../src/mcp/artifact-store.ts";

const dir = mkdtempSync(join(tmpdir(), "ui-fixture-"));
const packageRoot = join(dir, "mcp-package");
mkdirSync(packageRoot);
writeFileSync(join(packageRoot, "server.cjs"), [
  "let input = '';",
  "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const request = JSON.parse(input.slice(0, i)); input = input.slice(i + 1); if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ui-review-tools-fixture', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', description: 'Read-only review helper', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } }, { name: 'write', inputSchema: { type: 'object' } }] }); else if (request.method === 'tools/call') { if (request.params.name !== 'inspect') process.exit(24); reply(request.id, { content: [{ type: 'text', text: 'inspected:' + (request.params.arguments.path || '') }] }); } else if (request.id !== undefined) reply(request.id, {}); } });",
].join("\n"));
const artifact = importArtifact(packageRoot, join(dir, "state", "mcp-artifacts"));
writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({
  workspace: dir,
  stateDir: join(dir, "state"),
  profiles: ["claude-opus-advisor", "nemotron-worker"],
  mcpServers: [{
    id: "ui-review-tools",
    enabled: true,
    origin: "file:///ui-fixture/review-tools",
    version: "1.0.0",
    command: process.execPath,
    args: [],
    artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
    expectedServer: { name: "ui-review-tools-fixture", version: "1" },
    profiles: { "claude-opus-advisor": ["inspect"], "nemotron-worker": ["inspect"] },
  }],
  commands: [{ id: "unit-check", argv: [process.execPath, "-e", "process.exit(0)"] }],
  agentSkills: { "q33-inspect-agent": ["fixture-skill"] },
}));
const port = process.env["UI_PORT"] ?? "4199";
const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const child = spawn(process.execPath, [cli, "serve", "--port", port], { cwd: dir, env: { ...process.env, UI_P17_KEY: "sentinel-ui-p17-secret-never-return" }, stdio: "inherit" });
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
