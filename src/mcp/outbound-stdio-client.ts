import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
}

export interface ConnectedStdioMcpServer {
  serverInfo: McpJsonObject;
  capabilities: McpJsonObject;
  listTools(): Promise<OutboundMcpTool[]>;
  callTool(name: string, arguments_: McpJsonObject): Promise<OutboundMcpToolResult>;
  close(): Promise<void>;
}

/** `isError: true` is a valid tool-level failure and is preserved for the caller, not treated as JSON-RPC corruption. */
export interface OutboundMcpToolResult {
  [key: string]: McpJson | undefined;
  content: McpJson[];
  isError?: boolean;
}

export type OutboundMcpState = "new" | "starting" | "ready" | "stopping" | "closed" | "halted";

type Pending = { id: number; method: string; resolve: (value: McpJson) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const MAX_DEPTH = 64;
const MAX_KEYS = 20_000;
const MAX_TOOLS = 1_000;
const MAX_PAGES = 100;
const MAX_CURSOR_LENGTH = 2_048;
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROTOCOL_VERSION = "2025-11-25";
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

/**
 * Minimal MCP stdio client for registered operator-controlled servers. It intentionally exposes no arbitrary RPC,
 * notification, restart, or logging surface. One request is on the wire at a time; a timeout poisons and reaps the
 * child before rejecting, so a late response can never be mistaken for a later call.
 */
class OutboundStdioMcpClient {
  readonly #options: Required<Pick<OutboundMcpClientOptions, "startupTimeoutMs" | "callTimeoutMs" | "killGraceMs" | "maxMessageBytes">> & OutboundMcpClientOptions;
  #state: OutboundMcpState = "new";
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed: Promise<void> = Promise.resolve();
  #buffer = Buffer.alloc(0);
  #pending: Pending | null = null;
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();
  #tools = new Map<string, OutboundMcpTool>();
  #serverInfo: McpJsonObject | null = null;
  #capabilities: McpJsonObject | null = null;
  #terminating: Promise<void> | null = null;

  constructor(options: OutboundMcpClientOptions) {
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    const callTimeoutMs = options.callTimeoutMs ?? 10_000;
    const killGraceMs = options.killGraceMs ?? 1_000;
    const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
    if (!options.command || options.command.includes("\0") || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 ||
      !Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 ||
      !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > 16_777_216) {
      throw new Error("invalid outbound MCP client configuration");
    }
    if (!plainObject(options.env) || Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))) {
      throw new Error("outbound MCP environment must be an explicit string map");
    }
    if (options.args?.some((arg) => typeof arg !== "string" || arg.includes("\0")) || options.cwd?.includes("\0")) {
      throw new Error("invalid outbound MCP process arguments");
    }
    this.#options = { ...options, startupTimeoutMs, callTimeoutMs, killGraceMs, maxMessageBytes };
  }

  get state(): OutboundMcpState { return this.#state; }

  async start(): Promise<void> {
    if (this.#state !== "new") throw new Error(`outbound MCP client cannot start from ${this.#state}`);
    this.#state = "starting";
    this.#buffer = Buffer.alloc(0);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
        cwd: this.#options.cwd,
        env: { ...this.#options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      this.#state = "closed";
      throw new Error("could not start registered MCP server");
    }
    this.#child = child;
    this.#closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("error", () => this.#fatal("registered MCP server process failed"));
    child.once("close", () => {
      if (this.#state !== "stopping" && this.#state !== "closed" && this.#state !== "halted") this.#fatal("registered MCP server exited");
    });
    // Drain stderr to avoid child deadlocks, but never retain or surface its (possibly secret-bearing) contents.
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => this.#fatal("registered MCP server input closed"));
    child.stdout.on("data", (chunk: Buffer | string) => this.#onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    try {
      const init = asObject(await this.#rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "synapser", version: "0.1.0" },
      }, this.#options.startupTimeoutMs));
    if (!init || typeof init["protocolVersion"] !== "string" || !asObject(init["capabilities"]) || !asObject(init["serverInfo"])) {
        throw new Error("registered MCP server returned an invalid initialize result");
      }
      const serverInfo = init["serverInfo"] as McpJsonObject;
      if (typeof serverInfo["name"] !== "string" || typeof serverInfo["version"] !== "string") throw new Error("registered MCP server returned invalid identity");
      if (init["protocolVersion"] !== PROTOCOL_VERSION) throw new Error("registered MCP server negotiated an unsupported protocol version");
      this.#serverInfo = serverInfo;
      this.#capabilities = init["capabilities"] as McpJsonObject;
      if (this.#state !== "starting" || child.exitCode !== null || child.signalCode !== null) throw new Error("registered MCP server exited during initialization");
      await this.#sendInitialized();
      if (this.#state !== "starting" || child.exitCode !== null || child.signalCode !== null) throw new Error("registered MCP server exited during initialization");
      this.#state = "ready";
    } catch (error) {
      await this.#terminate();
      throw error instanceof Error ? error : new Error("registered MCP server initialization failed");
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

  listTools(): Promise<OutboundMcpTool[]> {
    return this.#enqueue(async () => {
      this.#assertReady();
      const tools = await this.#refreshTools();
      return tools.map((tool) => cloneJson(tool as unknown as McpJson) as unknown as OutboundMcpTool);
    });
  }

  callTool(name: string, args: McpJsonObject): Promise<OutboundMcpToolResult> {
    return this.#enqueue(async () => {
      this.#assertReady();
      if (!VALID_NAME.test(name) || !plainObject(args) || !validateJson(args)) throw new Error("invalid MCP tool call input");
      if (this.#tools.size === 0) await this.#refreshTools();
      const tool = this.#tools.get(name);
      if (!tool) throw new Error("MCP tool is not registered by the selected server");
      checkSchema(tool.inputSchema, args);
      const result = asObject(await this.#rpc("tools/call", { name, arguments: args }));
      if (!result || !Array.isArray(result["content"])) return this.#invalidResponse("registered MCP server returned an invalid tool result");
      if (result["isError"] !== undefined && typeof result["isError"] !== "boolean") return this.#invalidResponse("registered MCP server returned invalid tool error status");
      if (result["structuredContent"] !== undefined && !plainObject(result["structuredContent"])) return this.#invalidResponse("registered MCP server returned invalid structured content");
      if (tool.outputSchema !== undefined && !plainObject(result["structuredContent"])) return this.#invalidResponse("registered MCP server omitted required structured content");
      if (tool.outputSchema !== undefined) {
        try { checkSchema(tool.outputSchema, result["structuredContent"] as McpJson, "structuredContent"); }
        catch { return this.#invalidResponse("registered MCP server returned content outside its output schema"); }
      }
      for (const block of result["content"] as McpJson[]) {
        if (!plainObject(block) || typeof block["type"] !== "string") return this.#invalidResponse("registered MCP server returned invalid tool content");
        if (block["type"] === "text" && typeof block["text"] !== "string") return this.#invalidResponse("registered MCP server returned invalid text content");
        if (["image", "audio"].includes(block["type"]) && (typeof block["data"] !== "string" || typeof block["mimeType"] !== "string")) return this.#invalidResponse("registered MCP server returned invalid binary content");
        if (block["type"] === "resource_link" && (typeof block["uri"] !== "string" || typeof block["name"] !== "string")) return this.#invalidResponse("registered MCP server returned invalid resource link");
        if (block["type"] === "resource") {
          const resource = block["resource"];
          if (!plainObject(resource) || typeof resource["uri"] !== "string" ||
            (resource["mimeType"] !== undefined && typeof resource["mimeType"] !== "string") ||
            (typeof resource["text"] !== "string" && typeof resource["blob"] !== "string") ||
            (resource["text"] !== undefined && resource["blob"] !== undefined)) return this.#invalidResponse("registered MCP server returned invalid embedded resource");
        }
        if (!["text", "image", "audio", "resource_link", "resource"].includes(block["type"])) return this.#invalidResponse("registered MCP server returned unsupported content type");
      }
      return this.#redactSecrets(result) as OutboundMcpToolResult;
    });
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "new") { this.#state = "closed"; return; }
    if (this.#state === "halted") throw new Error("registered MCP server exit could not be confirmed");
    this.#state = "stopping";
    this.#rejectPending("outbound MCP client is closing");
    await this.#terminate();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #assertReady(): void {
    if (this.#state !== "ready") throw new Error(`outbound MCP client is ${this.#state}`);
  }

  #invalidResponse(message: string): never {
    this.#fatal(message);
    throw new Error(message);
  }

  #redactSecrets(result: McpJsonObject): McpJsonObject {
    // Convenience hygiene for accidental echoes only; this is not a security boundary against an operator-controlled server.
    const secrets = Object.entries(this.#options.env)
      .filter(([key, value]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && value.length >= 4)
      .map(([, value]) => value);
    if (secrets.length === 0) return result;
    const redact = (value: McpJson): McpJson => {
      if (typeof value === "string") return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
      if (Array.isArray(value)) return value.map(redact);
      if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(result) as McpJsonObject;
  }

  async #refreshTools(): Promise<OutboundMcpTool[]> {
    const next = new Map<string, OutboundMcpTool>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = asObject(await this.#rpc("tools/list", cursor === undefined ? {} : { cursor }));
      if (!result || !Array.isArray(result["tools"]) || (result["nextCursor"] !== undefined && typeof result["nextCursor"] !== "string")) {
        return this.#invalidResponse("registered MCP server returned an invalid tool list");
      }
      for (const raw of result["tools"] as McpJson[]) {
        if (!plainObject(raw) || typeof raw["name"] !== "string" || !VALID_NAME.test(raw["name"]) ||
          (raw["description"] !== undefined && typeof raw["description"] !== "string") || !validSchema(raw["inputSchema"]) ||
          (raw["outputSchema"] !== undefined && !validSchema(raw["outputSchema"]))) {
          return this.#invalidResponse("registered MCP server advertised an invalid tool");
        }
        if (next.has(raw["name"]) || next.size >= MAX_TOOLS) return this.#invalidResponse("registered MCP server advertised duplicate or excessive tools");
        next.set(raw["name"], freezeJson(cloneJson(raw)) as unknown as OutboundMcpTool);
      }
      const nextCursor = result["nextCursor"];
      if (nextCursor === undefined) {
        this.#tools = next;
        return [...next.values()];
      }
      if (nextCursor.length === 0 || nextCursor.length > MAX_CURSOR_LENGTH || cursors.has(nextCursor)) return this.#invalidResponse("registered MCP server returned an invalid pagination cursor");
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    return this.#invalidResponse("registered MCP server exceeded tool pagination limit");
  }

  async #sendInitialized(): Promise<void> {
    const child = this.#child;
    if (!child) throw new Error("registered MCP server is unavailable");
    const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`, "utf8");
    if (payload.byteLength > this.#options.maxMessageBytes) throw new Error("outbound MCP notification exceeds message limit");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("registered MCP server initialization notification timed out")), this.#options.startupTimeoutMs);
      child.stdin.write(payload, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error("registered MCP server input failed"));
        else resolve();
      });
    });
  }

  #rpc(method: "initialize" | "tools/list" | "tools/call", params: McpJsonObject, timeoutMs = this.#options.callTimeoutMs): Promise<McpJson> {
    return new Promise((resolve, reject) => {
      if (!this.#child || this.#state === "closed" || this.#state === "halted") return reject(new Error("registered MCP server is unavailable"));
      if (this.#pending) return reject(new Error("outbound MCP request overlap is not allowed"));
      const id = this.#nextId++;
      const pending: Pending = {
        id, method,
        resolve,
        reject,
        timer: setTimeout(() => void this.#onTimeout(id), timeoutMs),
      };
      this.#pending = pending;
      const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8");
      if (payload.byteLength > this.#options.maxMessageBytes) {
        clearTimeout(pending.timer);
        this.#pending = null;
        reject(new Error("outbound MCP request exceeds message limit"));
        return;
      }
      this.#child.stdin.write(payload, (error) => {
        if (error) this.#fatal("registered MCP server input failed");
      });
    });
  }

  #onData(chunk: Buffer): void {
    if (this.#state === "closed" || this.#state === "halted") return;
    let offset = 0;
    let newline: number;
    while ((newline = chunk.indexOf(0x0a, offset)) >= 0) {
      const segment = chunk.subarray(offset, newline);
      const lineBytes = this.#buffer.byteLength + segment.byteLength;
      if (lineBytes === 0 || lineBytes > this.#options.maxMessageBytes) {
        this.#fatal("registered MCP server sent an invalid message size");
        return;
      }
      const line = this.#buffer.byteLength === 0 ? segment : Buffer.concat([this.#buffer, segment], lineBytes);
      this.#buffer = Buffer.alloc(0);
      if (!this.#processLine(line)) return;
      offset = newline + 1;
    }
    const remainder = chunk.subarray(offset);
    if (this.#buffer.byteLength + remainder.byteLength > this.#options.maxMessageBytes) {
      this.#fatal("registered MCP server exceeded message limit");
      return;
    }
    if (remainder.byteLength > 0) this.#buffer = this.#buffer.byteLength === 0 ? Buffer.from(remainder) : Buffer.concat([this.#buffer, remainder]);
  }

  #processLine(line: Buffer): boolean {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { this.#fatal("registered MCP server sent malformed JSON"); return false; }
    if (!plainObject(message) || message["jsonrpc"] !== "2.0" || message["id"] !== this.#pending?.id ||
      ("result" in message) === ("error" in message) || Object.keys(message).some((key) => !["jsonrpc", "id", "result", "error"].includes(key))) {
      this.#fatal("registered MCP server sent an unexpected protocol message");
      return false;
    }
    const pending = this.#pending;
    if (!pending) { this.#fatal("registered MCP server sent an unsolicited message"); return false; }
    clearTimeout(pending.timer);
    this.#pending = null;
    if ("error" in message) {
      // Remote text may contain credentials or request arguments; do not copy it into errors or logs.
      if (!plainObject(message["error"]) || typeof message["error"]["code"] !== "number" || typeof message["error"]["message"] !== "string") {
        this.#fatal("registered MCP server returned an invalid protocol error");
        return false;
      }
      pending.reject(new Error("registered MCP server returned a protocol error"));
    } else if (!validateJson(message["result"])) {
      this.#fatal("registered MCP server returned a non-JSON result");
      return false;
    } else pending.resolve(message["result"]);
    return true;
  }

  async #onTimeout(id: number): Promise<void> {
    if (this.#pending?.id !== id) return;
    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    this.#state = "stopping";
    await this.#terminate();
    pending.reject(new Error(`registered MCP server timed out during ${pending.method}`));
  }

  #fatal(message: string): void {
    if (this.#state === "closed" || this.#state === "halted" || this.#state === "stopping") return;
    this.#state = "stopping";
    this.#rejectPending(message);
    void this.#terminate();
  }

  #rejectPending(message: string): void {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.reject(new Error(message));
  }

  async #terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#terminating = this.#terminateOnce();
    try { await this.#terminating; } finally { this.#terminating = null; }
  }

  async #terminateOnce(): Promise<void> {
    const child = this.#child;
    if (!child) {
      if (this.#state !== "halted") this.#state = "closed";
      return;
    }
    const groupId = process.platform === "win32" ? undefined : child.pid;
    if (child.exitCode === null && child.signalCode === null) this.#signal(child, "SIGTERM");
    // Give the registered process and descendants a short cleanup window, even if the parent exits first.
    await new Promise<void>((resolve) => setTimeout(resolve, this.#options.killGraceMs));
    if (groupId !== undefined) {
      this.#signal(child, "SIGKILL"); // Still targets the dedicated process group if its leader already exited.
    } else if (child.exitCode === null && child.signalCode === null) this.#signal(child, "SIGKILL");
    const parentReaped = await this.#waitForClose(this.#options.killGraceMs);
    const groupReaped = groupId === undefined || await this.#waitForGroupExit(groupId, this.#options.killGraceMs);
    this.#state = parentReaped && groupReaped ? "closed" : "halted";
  }

  #signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may have exited between the state probe and signal delivery; confirmation still uses close.
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  }

  async #waitForClose(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout;
    const result = await Promise.race([
      this.#closed.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
    clearTimeout(timer!);
    return result;
  }

  async #waitForGroupExit(groupId: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { process.kill(-groupId, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    try { process.kill(-groupId, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
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
  });
  await client.start();
  return {
    serverInfo: client.serverInfo,
    capabilities: client.capabilities,
    listTools: () => client.listTools(),
    callTool: (name, arguments_) => client.callTool(name, arguments_),
    close: () => client.close(),
  };
}
