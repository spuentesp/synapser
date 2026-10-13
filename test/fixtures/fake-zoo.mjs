// Minimal fake MCP server for S13: the FIRST claim_files call (per marker file) is swallowed
// and the process keeps running, like a wedged coordinator. Later processes behave.
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.env.FAKE_ZOO_MARKER;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const tool = (id, body) => reply(id, { content: [{ type: "text", text: JSON.stringify(body) }], isError: false });
const names = ["claim_files","list_claims","register_agent","rejoin_agent","post_intention","update_post","list_posts","get_audit_log"];

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize")
    return reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zoanthrope", version: "0.1.3" } });
  if (m.method === "tools/list") return reply(m.id, { tools: names.map((name) => ({ name })) });
  if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "claim_files" && !existsSync(marker)) {
      writeFileSync(marker, String(process.pid));
      return; // swallow: no response, stay alive
    }
    if (name === "list_claims") return tool(m.id, { ok: true, claims: [] });
    if (name === "claim_files")
      return tool(m.id, { ok: true, granted: a.files.map((path) => ({ path, intent: a.intent, claimed_at: 1, purpose: null, caller_stamps: [] })) });
  }
});
