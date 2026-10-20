// Plan 19 RCP6h: an MCP tool the operator declared as an effect is reached only through the broker. An agent asks
// for `mcp.call`; the broker decides and, once approved, runs the call here. The call uses the pinned server in a
// scratch HOME with none of the broker's environment, and its output is bounded and marked untrusted.
//
// `prepare` runs at request AND at execution (the broker compares the digests), so every live check lives there:
// a server disabled or re-pinned after approval fails closed, and so does any change to the registration itself.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOfJson } from "../digest/canonical.ts";
import { connectRegisteredMcpServer, type McpJsonObject } from "../mcp/outbound-stdio-client.ts";
import type { McpServerRegistration } from "../mcp/registry.ts";
import { EffectFailure, type EffectKind } from "./kinds.ts";

export const MCP_CALL = "mcp.call";
const MAX_ARGUMENTS = 20_000;
const MAX_OUTPUT = 4_000;
const SERVER = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface McpCallOptions {
  /** The live registration list: a change here is seen by the next request and by the re-check at execution. */
  registrations: () => readonly McpServerRegistration[];
  /** Where pinned artifacts are materialised: <stateDir>/mcp-artifacts. */
  artifactStoreRoot: string;
  callTimeoutMs?: number;
}

/** The profile whose allowlist names the tool, first by id: a deterministic choice the request cannot influence. */
const profileFor = (reg: McpServerRegistration, tool: string): string | undefined =>
  Object.keys(reg.profiles)
    .sort()
    .find((p) => reg.profiles[p]!.includes(tool));

function declaredEffect(options: McpCallOptions, server: string, tool: string): McpServerRegistration {
  const reg = options.registrations().find((s) => s.id === server);
  if (!reg) throw new EffectFailure("UNKNOWN_MCP_SERVER", `unknown MCP server ${server}`);
  if (!reg.enabled) throw new EffectFailure("MCP_SERVER_DISABLED", `MCP server ${server} is disabled`);
  if (!reg.artifact) throw new EffectFailure("MCP_ARTIFACT_UNPINNED", `MCP server ${server} has no pinned artifact`);
  if (!(reg.effectTools ?? []).includes(tool)) throw new EffectFailure("MCP_TOOL_NOT_EFFECT", `${tool} is not an operator-declared effect tool of ${server}`);
  return reg;
}

/** An exact server/tool pair the run's recipe selected (plan 19 RCP6g). */
export interface McpGrant {
  serverId: string;
  toolName: string;
}

/**
 * RCP6i: an `mcp.call` is requested by a native worker, for a pair the run's recipe selected. `undefined` grants
 * means an ordinary workflow: no recipe, so no MCP effect. Returns the refusal reason, or null when it may proceed.
 * The policy still decides after this; authorization only narrows who may ask.
 */
export function authorizeMcpCall(grants: readonly McpGrant[] | undefined, request: { params: Record<string, unknown>; role: string | null }): string | null {
  if (request.role !== "worker") return "an MCP effect may only be requested by a native worker";
  if (grants === undefined) return "this run has no recipe MCP selection";
  const server = String(request.params["server"]);
  const tool = String(request.params["tool"]);
  if (!grants.some((g) => g.serverId === server && g.toolName === tool)) return `MCP tool ${tool} on ${server} is not selected by this run's recipe`;
  return null;
}

export function mcpCallKind(options: McpCallOptions): EffectKind {
  return {
    kind: MCP_CALL,
    validate(params) {
      const x = params as { server?: unknown; tool?: unknown; arguments?: unknown } | null;
      const errors: string[] = [];
      if (typeof x?.server !== "string" || !SERVER.test(x.server)) errors.push("server must be a registered MCP server id");
      if (typeof x?.tool !== "string" || !TOOL.test(x.tool)) errors.push("tool must be a valid tool name");
      if (!x?.arguments || typeof x.arguments !== "object" || Array.isArray(x.arguments)) errors.push("arguments must be a JSON object");
      else if (JSON.stringify(x.arguments).length > MAX_ARGUMENTS) errors.push(`arguments exceed ${MAX_ARGUMENTS} characters`);
      if (errors.length) return { ok: false, errors };
      return { ok: true, params: { server: x!.server as string, tool: x!.tool as string, arguments: x!.arguments as Record<string, unknown> } };
    },
    async prepare(params) {
      const server = String(params["server"]);
      const tool = String(params["tool"]);
      const reg = declaredEffect(options, server, tool);
      const argumentsDigest = digestOfJson(params["arguments"]);
      return {
        // The whole registration is bound, not only the pin: a changed command or args after approval is STALE.
        material: { server, tool, registration: digestOfJson(JSON.parse(JSON.stringify(reg))), arguments: argumentsDigest },
        summary: `call MCP tool ${tool} on ${server} (arguments ${argumentsDigest.slice(0, 16)})`,
        details: { server, tool },
      };
    },
    async execute(params, _prepared, _ctx) {
      const server = String(params["server"]);
      const tool = String(params["tool"]);
      const reg = declaredEffect(options, server, tool);
      const profileId = profileFor(reg, tool);
      if (!profileId) throw new EffectFailure("MCP_TOOL_NOT_ALLOWLISTED", `no profile of ${server} allowlists ${tool}`);
      // The broker's environment (the user's git and gh credentials) is never forwarded: only a scratch HOME.
      const scratch = mkdtempSync(join(tmpdir(), "synapser-mcp-effect-"));
      const home = join(scratch, "home");
      const cwd = join(scratch, "work");
      mkdirSync(home);
      mkdirSync(cwd);
      let client: Awaited<ReturnType<typeof connectRegisteredMcpServer>> | undefined;
      try {
        client = await connectRegisteredMcpServer({
          registration: reg,
          profileId,
          artifactStoreRoot: options.artifactStoreRoot,
          env: { HOME: home },
          cwd,
          timeoutMs: 10_000,
        });
        const result = await client.callTool(tool, params["arguments"] as McpJsonObject, { timeoutMs: options.callTimeoutMs ?? 30_000 });
        const text = JSON.stringify(result);
        return {
          trust: "UNTRUSTED_MCP_DATA",
          output: text.slice(0, MAX_OUTPUT),
          truncated: text.length > MAX_OUTPUT,
          output_digest: digestOfJson(result),
          is_error: result.isError === true,
        };
      } catch (e) {
        if (e instanceof EffectFailure) throw e;
        throw new EffectFailure("MCP_CALL_FAILED", String((e as Error).message ?? e).slice(0, 300));
      } finally {
        try {
          await client?.close();
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
  };
}
