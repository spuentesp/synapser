import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectRegisteredMcpServer, type OutboundMcpTool } from "./outbound-stdio-client.ts";
import type { McpServerRegistration } from "./registry.ts";

export interface McpServerDiscovery {
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools: OutboundMcpTool[];
}

/** Probe an enabled, operator-registered server without credentials and without invoking any tool. */
export async function discoverRegisteredMcpServer(registration: McpServerRegistration, profileId: string, artifactStoreRoot: string): Promise<McpServerDiscovery> {
  const scratch = mkdtempSync(join(tmpdir(), "synapser-mcp-discovery-"));
  const home = join(scratch, "home");
  const cwd = join(scratch, "work");
  mkdirSync(home);
  mkdirSync(cwd);
  let client: Awaited<ReturnType<typeof connectRegisteredMcpServer>> | undefined;
  try {
    client = await connectRegisteredMcpServer({
      registration,
      profileId,
      artifactStoreRoot,
      env: { HOME: home },
      cwd,
      timeoutMs: 10_000,
    });
    const tools = await client.listTools();
    return {
      serverInfo: client.serverInfo,
      capabilities: client.capabilities,
      tools,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
