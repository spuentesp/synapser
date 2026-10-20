// Plan 19 RCP6j: the MCP surface one CLI run sees. It is a pure JSON-RPC handler over the run's recipe selection:
// it lists only the tools the recipe selected, sends read-only calls to the frozen run snapshot, and sends effect
// calls to the broker as `mcp.call` requests. It holds no credentials and spawns nothing itself: the transport
// that carries these messages is a separate step.

export const BRIDGE_PROTOCOL = "2025-06-18";
export const EFFECT_STATUS_TOOL = "effect_status";

export interface BridgeTool {
  /** The name the CLI sees. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeEffectTool extends BridgeTool {
  /** The registered server and tool the broker will run once a human approves. */
  server: string;
  tool: string;
}

export interface CliBridgeOptions {
  readOnly: readonly BridgeTool[];
  effects: readonly BridgeEffectTool[];
  /** Runs a selected read-only tool against the frozen run snapshot. Its output is data, never instructions. */
  callReadOnly: (name: string, args: unknown) => Promise<unknown>;
  /** Asks the broker for the effect. The broker decides; this never runs it. */
  requestEffect: (r: { server: string; tool: string; arguments: Record<string, unknown>; taskId: string }) => Promise<{ id: string; state: string; summary: string }>;
  /** The outcome of an effect requested earlier in this run. */
  effectStatus: (id: string) => { state: string; reason: string | null; evidence: Record<string, unknown> | null } | null;
  taskId: string;
}

const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const untrusted = (value: unknown) => ({ content: [{ type: "text", text: `UNTRUSTED_MCP_DATA ${JSON.stringify(value)}` }] });

/** Builds the handler for one run. `handle` returns the reply to a request, or undefined for a notification. */
export function createCliBridge(o: CliBridgeOptions): { handle: (message: unknown) => Promise<unknown | undefined> } {
  const readOnly = new Map(o.readOnly.map((t) => [t.name, t]));
  const effects = new Map(o.effects.map((t) => [t.name, t]));
  const statusTool: BridgeTool = {
    name: EFFECT_STATUS_TOOL,
    description: "Read the outcome of an effect you requested. The effect runs only after a human approves it.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
  };
  const listed = (): BridgeTool[] => [...readOnly.values(), ...[...effects.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), statusTool];

  return {
    async handle(message) {
      const m = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (typeof m.method !== "string") return m.id === undefined ? undefined : failure(m.id, -32600, "invalid request");
      if (m.id === undefined) return undefined; // notifications, such as notifications/initialized, get no reply
      switch (m.method) {
        case "initialize": {
          const requested = typeof m.params?.["protocolVersion"] === "string" ? (m.params["protocolVersion"] as string) : BRIDGE_PROTOCOL;
          return result(m.id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "synapser-bridge", version: "1" } });
        }
        case "ping":
          return result(m.id, {});
        case "tools/list":
          return result(m.id, { tools: listed() });
        case "tools/call": {
          const name = typeof m.params?.["name"] === "string" ? (m.params["name"] as string) : "";
          const args = (m.params?.["arguments"] ?? {}) as Record<string, unknown>;
          if (name === EFFECT_STATUS_TOOL) {
            const st = o.effectStatus(String(args["id"]));
            return st ? result(m.id, untrusted(st)) : failure(m.id, JSON_RPC_INVALID_PARAMS, "unknown effect");
          }
          const effect = effects.get(name);
          if (effect) {
            // a request, not a performance: the broker decides and a human approves before anything runs
            const r = await o.requestEffect({ server: effect.server, tool: effect.tool, arguments: args, taskId: o.taskId });
            return result(m.id, untrusted({ effect_id: r.id, state: r.state, summary: r.summary, note: "Call effect_status with this id to read the outcome." }));
          }
          if (readOnly.has(name)) return result(m.id, untrusted(await o.callReadOnly(name, args)));
          // refused without touching anything: a tool the recipe did not select is not in this run at all
          return failure(m.id, JSON_RPC_INVALID_PARAMS, `tool ${name} is not selected for this run`);
        }
        default:
          return failure(m.id, JSON_RPC_METHOD_NOT_FOUND, `method ${m.method} is not supported`);
      }
    },
  };
}
