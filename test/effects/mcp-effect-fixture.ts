import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importMcpArtifact } from "../../src/mcp/artifact-store.ts";
import { type McpServerRegistration, validateMcpServerRegistry } from "../../src/mcp/registry.ts";

// The pinned fixture shared by the RCP6h tests: a real MCP stdio server whose `send_mail` tool is an operator-declared
// effect and whose `inspect` tool is an ordinary allowlisted tool. The server cannot write files (the sandbox confines
// it), so it reports what it received in its result.
export function effectFixture(dir: string): { servers: McpServerRegistration[]; artifactStoreRoot: string } {
    const packageRoot = join(dir, "package");
    mkdirSync(packageRoot);
    // The fixture is a plain JSON-RPC stdio server. It cannot write files (the sandbox confines it), so it reports in its result.
    writeFileSync(join(packageRoot, "server.cjs"), [
      "let input = '';",
      "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; for (;;) { const i = input.indexOf('\\n'); if (i < 0) return; const line = input.slice(0, i); input = input.slice(i + 1); const request = JSON.parse(line);",
      "  if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'effect-fixture', version: '1' } });",
      "  else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }, { name: 'send_mail', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false } }] });",
      "  else if (request.method === 'tools/call') reply(request.id, { content: [{ type: 'text', text: 'sent to ' + request.params.arguments.to + ' env:' + Object.keys(process.env).sort().join(',') }] });",
      "  else if (request.id !== undefined) reply(request.id, {});",
      "} });",
    ].join("\n"));
    const artifact = importMcpArtifact(packageRoot, join(dir, "artifact-store"));
    const parsed = validateMcpServerRegistry([{
      id: "mail",
      enabled: true,
      origin: "file:///tmp/effect-fixture",
      version: "1.0.0",
      command: process.execPath,
      args: [],
      artifact: { digest: artifact.digest, entrypoint: "server.cjs" },
      expectedServer: { name: "effect-fixture", version: "1" },
      profiles: { "nemotron-worker": ["inspect", "send_mail"] },
      effectTools: ["send_mail"],
    }], ["nemotron-worker"], ["nemotron-worker"]);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return { servers: parsed.servers, artifactStoreRoot: join(dir, "artifact-store") };
}
