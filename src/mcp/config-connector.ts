// Plan 17 P17.8 step 3: the configuration connector. A stdio MCP server that forwards its calls to the running Synapser
// API with the operator token from its environment. It is the only MCP surface that writes configuration (K3), and the
// task connector never exposes these tools. No CLI is given it (K6): the token lives in the operator's client config only.
// The token is never printed, and an API answer is passed back as text, with its validation problems and no secret.

type Json = Record<string, unknown>;

const OBJECT = { type: "object" } as const;

export const CONFIG_TOOLS = [
  {
    name: "config_put_provider",
    description: "Create or replace an operator provider: {id, provider}. The change is validated against the whole configuration, written to the operator's file and applied at once. Key values are never accepted: only variable names.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, provider: OBJECT }, required: ["id", "provider"] },
  },
  {
    name: "config_put_role",
    description: "Assign a system role: {role, assignment}, where assignment is {provider, model, temperature?, fallbacks?}. The provider must declare the model.",
    inputSchema: { type: "object", properties: { role: { type: "string" }, assignment: OBJECT }, required: ["role", "assignment"] },
  },
] as const;

export interface ConfigConnectorOptions {
  /** Base URL of the running API, for example http://127.0.0.1:4173. */
  apiUrl: string;
  /** The operator token the API was started with (SYNAPSER_OPERATOR_TOKEN). */
  token: string;
  fetchImpl?: typeof fetch;
}

const reply = (id: unknown, result: unknown): Json => ({ jsonrpc: "2.0", id: id ?? null, result });
const failure = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolText = (text: string, isError: boolean): Json => ({ content: [{ type: "text", text: text.slice(0, 4000) }], isError });

export class ConfigConnector {
  readonly #api: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(o: ConfigConnectorOptions) {
    if (!o.token || o.token.length < 32) throw new Error("SYNAPSER_OPERATOR_TOKEN must be set to at least 32 characters");
    this.#api = o.apiUrl.replace(/\/+$/, "");
    this.#token = o.token;
    this.#fetch = o.fetchImpl ?? fetch;
  }

  async handle(msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }): Promise<Json | null> {
    if (msg.id === undefined) return null; // notifications get no answer
    switch (msg.method) {
      case "initialize":
        return reply(msg.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synapser-config", version: "0.1.0" } });
      case "ping":
        return reply(msg.id, {});
      case "tools/list":
        return reply(msg.id, { tools: CONFIG_TOOLS });
      case "tools/call":
        return reply(msg.id, await this.#call((msg.params ?? {}) as { name?: unknown; arguments?: unknown }));
      default:
        return failure(msg.id, -32601, `method not found: ${String(msg.method)}`);
    }
  }

  async #call(params: { name?: unknown; arguments?: unknown }): Promise<Json> {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    let path: string;
    let body: unknown;
    if (params.name === "config_put_provider") {
      if (typeof args["id"] !== "string" || !args["provider"]) return toolText("id and provider are required", true);
      path = `/api/config/providers/${encodeURIComponent(args["id"])}`;
      body = args["provider"];
    } else if (params.name === "config_put_role") {
      if (typeof args["role"] !== "string" || !args["assignment"]) return toolText("role and assignment are required", true);
      path = `/api/config/roles/${encodeURIComponent(args["role"])}`;
      body = args["assignment"];
    } else {
      return toolText(`unknown tool ${String(params.name)}`, true);
    }
    try {
      const r = await this.#fetch(this.#api + path, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: this.#api, "x-synapser-token": this.#token },
        body: JSON.stringify(body),
      });
      return toolText(`${r.status} ${await r.text()}`, r.status >= 400);
    } catch {
      return toolText("the Synapser API did not answer; is `synapser serve` running at the configured SYNAPSER_API_URL?", true);
    }
  }
}
