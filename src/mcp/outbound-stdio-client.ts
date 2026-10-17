import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, SdkErrorCode, type CallToolResult, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";

/** JSON data that can safely cross the MCP stdio boundary. */
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };
export type McpJsonObject = { [key: string]: McpJson };

export interface OutboundMcpTool {
  name: string;
  description?: string;
  outputSchema?: McpJsonObject;
  inputSchema: McpJsonObject;
  [key: string]: McpJson | undefined;
}

export interface OutboundMcpClientOptions {
  /** Absolute or PATH-resolved executable selected by the trusted operator registry. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Deliberately explicit: the caller decides which named credentials reach this process. */
  env: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  killGraceMs?: number;
  maxMessageBytes?: number;
  signal?: AbortSignal;
}

export interface ConnectStdioMcpServerOptions {
  command: string;
  args?: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  /** Common deadline for startup and requests. More specific values override it. */
  timeoutMs?: number;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  killGraceMs?: number;
  maxMessageBytes?: number;
  signal?: AbortSignal;
}

export interface ConnectedStdioMcpServer {
  serverInfo: McpJsonObject;
  capabilities: McpJsonObject;
  listTools(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OutboundMcpTool[]>;
  callTool(name: string, arguments_: McpJsonObject, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OutboundMcpToolResult>;
  close(): Promise<void>;
}

/** `isError: true` is a valid tool-level failure and is preserved for the caller, not treated as JSON-RPC corruption. */
export interface OutboundMcpToolResult {
  [key: string]: McpJson | undefined;
  content: McpJson[];
  isError?: boolean;
}

export type OutboundMcpState = "new" | "starting" | "ready" | "stopping" | "closed" | "halted";

const MAX_DEPTH = 64;
const MAX_KEYS = 20_000;
const MAX_TOOLS = 1_000;
const MAX_PAGES = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_MESSAGE_BYTES = 1_048_576;
const SETSID = "/usr/bin/setsid";
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SCHEMA_KEYS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "properties", "required", "items", "additionalProperties", "enum", "const", "minProperties", "maxProperties",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateJson(value: unknown, depth = 0, budget = { keys: 0 }): value is McpJson {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= MAX_KEYS && value.every((item) => validateJson(item, depth + 1, budget));
  if (!plainObject(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    budget.keys++;
    if (budget.keys > MAX_KEYS || key === "__proto__" || key === "constructor" || key === "prototype") return false;
    if (!validateJson(item, depth + 1, budget)) return false;
  }
  return true;
}

function asObject(value: McpJson | undefined): McpJsonObject | undefined {
  return plainObject(value) && validateJson(value) ? (value as McpJsonObject) : undefined;
}

function cloneJson<T extends McpJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeJson<T extends McpJson>(value: T): T {
  if (Array.isArray(value)) for (const child of value) freezeJson(child);
  else if (plainObject(value)) for (const child of Object.values(value)) if (child !== undefined) freezeJson(child as McpJson);
  return Object.freeze(value);
}

function validSchema(value: unknown, depth = 0): value is McpJsonObject {
  if (!plainObject(value) || !validateJson(value) || depth > 24) return false;
  if (Object.keys(value).some((key) => !SCHEMA_KEYS.has(key))) return false;
  const type = value["type"];
  const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (type !== undefined && !((typeof type === "string" && supportedTypes.has(type)) ||
    (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string" && supportedTypes.has(t))))) return false;
  const properties = value["properties"];
  if (properties !== undefined) {
    if (!plainObject(properties)) return false;
    for (const [key, schema] of Object.entries(properties)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype" || !validSchema(schema, depth + 1)) return false;
    }
  }
  const required = value["required"];
  if (required !== undefined && (!Array.isArray(required) || !required.every((x) => typeof x === "string"))) return false;
  if (value["items"] !== undefined && !validSchema(value["items"], depth + 1)) return false;
  if (value["additionalProperties"] !== undefined && typeof value["additionalProperties"] !== "boolean" && !validSchema(value["additionalProperties"], depth + 1)) return false;
  if (value["enum"] !== undefined && !Array.isArray(value["enum"])) return false;
  for (const key of ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return false;
  }
  for (const key of ["minimum", "maximum"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return false;
  return true;
}

/** A deliberately small, fail-closed validator for the common JSON Schema subset used by MCP tools. */
function checkSchema(schema: McpJsonObject, value: McpJson, path = "arguments"): void {
  const types = schema["type"] === undefined ? [] : Array.isArray(schema["type"]) ? schema["type"] as string[] : [schema["type"] as string];
  const matchesType = (type: string): boolean => {
    switch (type) {
      case "object": return plainObject(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "integer": return typeof value === "number" && Number.isSafeInteger(value);
      case "boolean": return typeof value === "boolean";
      case "null": return value === null;
      default: return false;
    }
  };
  if (types.length > 0 && !types.some(matchesType)) throw new Error(`MCP tool input does not match schema at ${path}`);
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as McpJson[]).some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`MCP tool input is outside enum at ${path}`);
  }
  if (schema["const"] !== undefined && JSON.stringify(schema["const"]) !== JSON.stringify(value)) throw new Error(`MCP tool input does not match const at ${path}`);
  if (plainObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) for (const key of required) if (!(key as string in value)) throw new Error(`MCP tool input is missing ${path}.${String(key)}`);
    const properties = plainObject(schema["properties"]) ? schema["properties"] : {};
    for (const [key, item] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) checkSchema(childSchema as McpJsonObject, item, `${path}.${key}`);
      else if (schema["additionalProperties"] === false) throw new Error(`MCP tool input has an unexpected field at ${path}.${key}`);
      else if (plainObject(schema["additionalProperties"])) checkSchema(schema["additionalProperties"] as McpJsonObject, item, `${path}.${key}`);
    }
    const min = schema["minProperties"];
    const max = schema["maxProperties"];
    if (typeof min === "number" && Object.keys(value).length < min) throw new Error(`MCP tool input has too few fields at ${path}`);
    if (typeof max === "number" && Object.keys(value).length > max) throw new Error(`MCP tool input has too many fields at ${path}`);
  }
  if (Array.isArray(value)) {
    const itemSchema = schema["items"];
    if (plainObject(itemSchema)) value.forEach((item, index) => checkSchema(itemSchema as McpJsonObject, item, `${path}[${index}]`));
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) throw new Error(`MCP tool input has too few items at ${path}`);
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) throw new Error(`MCP tool input has too many items at ${path}`);
  }
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) throw new Error(`MCP tool input is too short at ${path}`);
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) throw new Error(`MCP tool input is too long at ${path}`);
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) throw new Error(`MCP tool input is below minimum at ${path}`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) throw new Error(`MCP tool input exceeds maximum at ${path}`);
  }
}

function processGroupOf(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    // The remainder begins at field 3 (state): ppid is index 1 and pgrp is index 2.
    const fields = stat.slice(end + 1).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * SDK stdio transport with an outbound frame bound. The SDK owns JSON-RPC framing and protocol behavior;
 * this narrow override only keeps Synapser's smaller request-size ceiling.
 */
class BoundedStdioClientTransport extends StdioClientTransport {
  readonly #maxMessageBytes: number;
  #verifiedProcessGroup: number | null = null;
  #spawnedPid: number | null = null;

  constructor(options: StdioServerParameters, maxMessageBytes: number) {
    super(options);
    this.#maxMessageBytes = maxMessageBytes;
  }

  override send(message: JSONRPCMessage): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(message), "utf8") + 1 > this.#maxMessageBytes) {
      return Promise.reject(new Error("outbound MCP request exceeds message limit"));
    }
    return super.send(message);
  }

  get verifiedProcessGroup(): number | null { return this.#verifiedProcessGroup; }
  get spawnedPid(): number | null { return this.#spawnedPid; }

  override async start(): Promise<void> {
    await super.start();
    const pid = this.pid;
    if (pid === null) throw new Error("registered MCP process did not start");
    this.#spawnedPid = pid;
    // Verify before Client.connect sends initialize. This prevents a fast-failing server from exiting
    // before the supervisor has captured the dedicated process group needed to reap descendants.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (processGroupOf(pid) === pid) {
        this.#verifiedProcessGroup = pid;
        return;
      }
      if (this.pid === null) break;
      await delay(1);
    }
    throw new Error("registered MCP process group could not be verified");
  }
}

function isolatedEnvironment(input: Readonly<Record<string, string>>, cwd?: string): Record<string, string> {
  if (!Object.hasOwn(input, "HOME")) throw new Error("outbound MCP requires an explicit scratch HOME");
  const home = input["HOME"];
  if (typeof home !== "string" || !isAbsolute(home) || !existsSync(home)) throw new Error("outbound MCP scratch HOME must be an existing absolute directory");
  const out: Record<string, string> = {};
  // StdioClientTransport merges this environment with its safe defaults. Replace every inherited key so no host
  // identity or path value leaks through that merge. Only explicit, non-secret caller variables survive below.
  for (const key of DEFAULT_INHERITED_ENV_VARS) out[key] = "";
  out["HOME"] = home;
  if (process.platform === "win32") {
    // Windows has no supported process-group teardown in this wrapper; this is only defensive if that changes.
    out["PATH"] = "";
  } else {
    out["PATH"] = "/usr/bin:/bin";
    out["USER"] = "synapser";
    out["LOGNAME"] = "synapser";
    out["SHELL"] = "/bin/sh";
    out["TERM"] = "dumb";
  }
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("outbound MCP environment must be explicit string values");
    if (/(?:TOKEN|API[-_]?KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) throw new Error("outbound MCP environment must not contain credential variables");
    // These values are derived from Synapser's scratch boundary, never accepted from a caller.
    if (DEFAULT_INHERITED_ENV_VARS.some((inherited) => inherited.toUpperCase() === key.toUpperCase())) continue;
    out[key] = value;
  }
  if (cwd !== undefined && (!isAbsolute(cwd) || !existsSync(cwd))) throw new Error("outbound MCP cwd must be an existing absolute path");
  return out;
}

function asMcpTool(raw: unknown): OutboundMcpTool | null {
  if (!plainObject(raw) || typeof raw["name"] !== "string" || !VALID_NAME.test(raw["name"]) ||
    (raw["description"] !== undefined && typeof raw["description"] !== "string") || !validSchema(raw["inputSchema"]) ||
    (raw["outputSchema"] !== undefined && !validSchema(raw["outputSchema"]))) return null;
  return {
    name: raw["name"],
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    inputSchema: cloneJson(raw["inputSchema"] as McpJsonObject),
    ...(raw["outputSchema"] !== undefined ? { outputSchema: cloneJson(raw["outputSchema"] as McpJsonObject) } : {}),
  };
}

function safeCallResult(result: CallToolResult, tool: OutboundMcpTool): OutboundMcpToolResult {
  if (!Array.isArray(result.content) || result.content.length > MAX_KEYS || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new Error("registered MCP server returned invalid tool content");
  }
  const content: McpJson[] = [];
  for (const block of result.content as unknown[]) {
    if (!plainObject(block) || typeof block["type"] !== "string" || !validateJson(block)) throw new Error("registered MCP server returned invalid tool content");
    if (block["type"] === "text" && typeof block["text"] !== "string") throw new Error("registered MCP server returned invalid text content");
    if (["image", "audio"].includes(block["type"]) && (typeof block["data"] !== "string" || typeof block["mimeType"] !== "string")) throw new Error("registered MCP server returned invalid binary content");
    if (block["type"] === "resource_link" && (typeof block["uri"] !== "string" || typeof block["name"] !== "string")) throw new Error("registered MCP server returned invalid resource link");
    if (block["type"] === "resource") {
      const resource = block["resource"];
      if (!plainObject(resource) || typeof resource["uri"] !== "string" ||
        (resource["mimeType"] !== undefined && typeof resource["mimeType"] !== "string") ||
        (typeof resource["text"] !== "string" && typeof resource["blob"] !== "string") ||
        (resource["text"] !== undefined && resource["blob"] !== undefined)) throw new Error("registered MCP server returned invalid embedded resource");
    }
    if (!["text", "image", "audio", "resource_link", "resource"].includes(block["type"])) throw new Error("registered MCP server returned unsupported content type");
    content.push(cloneJson(block as McpJson));
  }
  if (result.structuredContent !== undefined && !validateJson(result.structuredContent)) throw new Error("registered MCP server returned invalid structured content");
  if (tool.outputSchema !== undefined) {
    if (!plainObject(result.structuredContent) && !result.isError) throw new Error("registered MCP server omitted required structured content");
    if (plainObject(result.structuredContent)) {
      try { checkSchema(tool.outputSchema, result.structuredContent as McpJson, "structuredContent"); }
      catch { throw new Error("registered MCP server returned content outside its output schema"); }
    }
  }
  return {
    content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: cloneJson(result.structuredContent as McpJson) } : {}),
  };
}

/**
 * Minimal MCP stdio client for registered operator-controlled servers. It intentionally exposes no arbitrary RPC,
 * notification, restart, or logging surface. One request is on the wire at a time; a timeout poisons and reaps the
 * child before rejecting, so a late response can never be mistaken for a later call.
 */
class OutboundStdioMcpClient {
  readonly #options: Required<Pick<OutboundMcpClientOptions, "startupTimeoutMs" | "callTimeoutMs" | "killGraceMs" | "maxMessageBytes">> & OutboundMcpClientOptions;
  readonly #transport: BoundedStdioClientTransport;
  readonly #client: Client;
  #state: OutboundMcpState = "new";
  #queue: Promise<unknown> = Promise.resolve();
  #tools = new Map<string, OutboundMcpTool>();
  #serverInfo: McpJsonObject | null = null;
  #capabilities: McpJsonObject | null = null;
  #processGroup: number | null = null;
  #terminating: Promise<void> | null = null;

  constructor(options: OutboundMcpClientOptions) {
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    const callTimeoutMs = options.callTimeoutMs ?? 10_000;
    const killGraceMs = options.killGraceMs ?? 1_000;
    const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    if (!options.command || options.command.includes("\0") || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 ||
      !Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 ||
      !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > MAX_MESSAGE_BYTES) {
      throw new Error("invalid outbound MCP client configuration");
    }
    if (!plainObject(options.env) || options.args?.some((arg) => typeof arg !== "string" || arg.includes("\0")) || options.cwd?.includes("\0")) {
      throw new Error("invalid outbound MCP process configuration");
    }
    if (process.platform !== "linux" || !existsSync(SETSID)) throw new Error("registered MCP stdio is unavailable: verified Linux process-group supervision is required");
    const env = isolatedEnvironment(options.env, options.cwd);
    this.#options = { ...options, startupTimeoutMs, callTimeoutMs, killGraceMs, maxMessageBytes, env };
    const server: StdioServerParameters = {
      command: SETSID,
      args: [options.command, ...(options.args ?? [])],
      cwd: options.cwd,
      env,
      stderr: "ignore",
      maxBufferSize: maxMessageBytes,
    };
    this.#transport = new BoundedStdioClientTransport(server, maxMessageBytes);
    // Do not enable modern discovery/elicitation negotiation for an untrusted child process. P19.5 pins the legacy
    // initialize path until those additional client capabilities have their own security and broker rules.
    this.#client = new Client(
      { name: "synapser", version: "0.1.0" },
      { versionNegotiation: { mode: "legacy" }, listMaxPages: MAX_PAGES, enforceStrictCapabilities: true },
    );
  }

  get state(): OutboundMcpState { return this.#state; }

  async start(): Promise<void> {
    if (this.#state !== "new") throw new Error(`outbound MCP client cannot start from ${this.#state}`);
    this.#state = "starting";
    const connection = this.#client.connect(this.#transport, {
      timeout: this.#options.startupTimeoutMs,
      ...(this.#options.signal ? { signal: this.#options.signal } : {}),
    });
    try {
      await connection;
      this.#processGroup = this.#transport.verifiedProcessGroup;
      const info = this.#client.getServerVersion();
      const caps = this.#client.getServerCapabilities();
      if (!info || typeof info.name !== "string" || typeof info.version !== "string" || !caps || !validateJson(caps)) {
        throw new Error("registered MCP server returned an invalid initialize result");
      }
      if (this.#processGroup === null) throw new Error("registered MCP server process group could not be verified");
      this.#serverInfo = { name: info.name, version: info.version };
      this.#capabilities = cloneJson(caps as unknown as McpJsonObject);
      this.#state = "ready";
    } catch {
      this.#processGroup = this.#transport.verifiedProcessGroup;
      await this.#terminate();
      throw new Error("registered MCP server failed initialization or process-group verification");
    }
  }

  get serverInfo(): McpJsonObject {
    if (!this.#serverInfo) throw new Error("registered MCP server has not initialized");
    return freezeJson(cloneJson(this.#serverInfo));
  }

  get capabilities(): McpJsonObject {
    if (!this.#capabilities) throw new Error("registered MCP server has not initialized");
    return freezeJson(cloneJson(this.#capabilities));
  }

  listTools(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OutboundMcpTool[]> {
    return this.#enqueue(async () => {
      this.#assertReady();
      return this.#refreshTools(options);
    });
  }

  callTool(name: string, args: McpJsonObject, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OutboundMcpToolResult> {
    return this.#enqueue(async () => {
      this.#assertReady();
      if (!VALID_NAME.test(name) || !plainObject(args) || !validateJson(args)) throw new Error("invalid MCP tool call input");
      if (this.#tools.size === 0) await this.#refreshTools(options);
      const tool = this.#tools.get(name);
      if (!tool) throw new Error("MCP tool is not registered by the selected server");
      checkSchema(tool.inputSchema, args);
      // Reject locally before entering the SDK request lifecycle: an oversized caller payload is not a
      // protocol failure and must not poison an otherwise healthy child session.
      if (Buffer.byteLength(JSON.stringify({ name, arguments: args }), "utf8") + 512 > this.#options.maxMessageBytes) {
        throw new Error("MCP request exceeds message limit");
      }
      return this.#request("tools/call", options.timeoutMs ?? this.#options.callTimeoutMs, options.signal, async (requestOptions) => {
        // Pass the immutable discovery snapshot: calls cannot silently acquire a changed schema after list_changed.
        const definition = tool as unknown as Tool;
        const raw = await this.#client.callTool({ name, arguments: args }, { ...requestOptions, toolDefinition: definition });
        return safeCallResult(raw, tool);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "halted") throw new Error("registered MCP server process-group exit could not be confirmed");
    await this.#terminate();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #refreshTools(options: { signal?: AbortSignal; timeoutMs?: number }): Promise<OutboundMcpTool[]> {
    const tools = new Map<string, OutboundMcpTool>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await this.#request("tools/list", options.timeoutMs ?? this.#options.callTimeoutMs, options.signal, (requestOptions) =>
          // Explicit params plus raw SDK request select one page; `listTools()` auto-aggregates and owns a separate cap.
          this.#client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, requestOptions));
        if (!response || !Array.isArray(response.tools) || (response.nextCursor !== undefined && typeof response.nextCursor !== "string")) {
          throw new Error("invalid tool list");
        }
        for (const raw of response.tools) {
          const tool = asMcpTool(raw);
          if (!tool) throw new Error("invalid advertised tool");
          if (tools.has(tool.name) || tools.size >= MAX_TOOLS) throw new Error("duplicate or excessive advertised tools");
          tools.set(tool.name, freezeJson(cloneJson(tool as unknown as McpJson)) as unknown as OutboundMcpTool);
        }
        const nextCursor = response.nextCursor;
        if (nextCursor === undefined) {
          this.#tools = tools;
          return [...tools.values()].map((tool) => cloneJson(tool as unknown as McpJson) as unknown as OutboundMcpTool);
        }
        if (nextCursor.length === 0 || nextCursor.length > MAX_CURSOR_LENGTH || cursors.has(nextCursor)) throw new Error("invalid pagination cursor");
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new Error("pagination limit exceeded");
    } catch (error) {
      if (error instanceof Error && ["pagination limit exceeded", "invalid tool list", "invalid advertised tool", "duplicate or excessive advertised tools", "invalid pagination cursor"].includes(error.message)) {
        await this.#terminate();
      }
      throw error;
    }
  }

  #assertReady(): void {
    if (this.#state !== "ready") throw new Error(`outbound MCP client is ${this.#state}`);
  }

  async #request<T>(method: "tools/list" | "tools/call", timeoutMs: number, callerSignal: AbortSignal | undefined, run: (options: { timeout: number; signal: AbortSignal }) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid outbound MCP request timeout");
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run({ timeout: timeoutMs, signal });
    } catch (error) {
      const timedOut = controller.signal.aborted && !callerSignal?.aborted || (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === SdkErrorCode.RequestTimeout);
      const canceled = callerSignal?.aborted === true;
      await this.#terminate();
      if (timedOut) throw new Error(`registered MCP server timed out during ${method}`);
      if (canceled) throw new Error(`registered MCP server request aborted during ${method}`);
      // Never surface protocol error text: it is controlled by the external server and can contain secrets.
      throw new Error(`registered MCP server failed during ${method}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async #terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#state = "stopping";
    this.#terminating = this.#terminateOnce();
    try { await this.#terminating; } finally { this.#terminating = null; }
  }

  async #terminateOnce(): Promise<void> {
    const pgid = this.#processGroup;
    let groupExited = pgid === null ? this.#transport.spawnedPid === null : !groupExists(pgid);
    if (pgid !== null && !groupExited) {
      // This negative PID is safe only because setsid is the direct executable and /proc proved PGID == its PID.
      try { process.kill(-pgid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") groupExited = false;
      }
      groupExited = await this.#waitForGroupExit(pgid, this.#options.killGraceMs);
      if (!groupExited) {
        try { process.kill(-pgid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") groupExited = false;
        }
        groupExited = await this.#waitForGroupExit(pgid, this.#options.killGraceMs * 2);
      }
    }
    try { await this.#client.close(); } catch { /* cleanup errors are reported by the verified process-group check */ }
    this.#state = groupExited ? "closed" : "halted";
    if (!groupExited) throw new Error("registered MCP server process-group exit could not be confirmed");
  }

  async #waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!groupExists(pgid)) return true;
      await delay(20);
    }
    return !groupExists(pgid);
  }
}

/** Connect to one operator-registered MCP stdio process using only the supported lifecycle and tool methods. */
export async function connectStdioMcpServer(options: ConnectStdioMcpServerOptions): Promise<ConnectedStdioMcpServer> {
  const commonTimeout = options.timeoutMs ?? 10_000;
  const client = new OutboundStdioMcpClient({
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    startupTimeoutMs: options.startupTimeoutMs ?? commonTimeout,
    callTimeoutMs: options.callTimeoutMs ?? commonTimeout,
    killGraceMs: options.killGraceMs,
    maxMessageBytes: options.maxMessageBytes,
    signal: options.signal,
  });
  await client.start();
  return {
    serverInfo: client.serverInfo,
    capabilities: client.capabilities,
    listTools: (requestOptions) => client.listTools(requestOptions),
    callTool: (name, arguments_, requestOptions) => client.callTool(name, arguments_, requestOptions),
    close: () => client.close(),
  };
}
