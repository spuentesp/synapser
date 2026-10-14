// Typed adapter over the real `zoanthrope mcp` process (design §13).
//
// Rules this module enforces by construction:
//  - only `WorkspacePath` values can be claimed (containment happens upstream, S15);
//  - `isError=false, ok=false` is a Conflict, never a grant (S14);
//  - `isError=true`, JSON-RPC errors, timeouts and malformed bodies throw ZooError and
//    are never downgraded to an advisory grant (S09);
//  - a grant is accepted only if it covers EXACTLY the requested set with the
//    requested intent, because grants carry no agent field (design §13);
//  - a timeout quarantines the adapter until `reconcile()` (S13).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorkspacePath } from "../workspace/paths.ts";
import { ZooTransport } from "./transport.ts";
import {
  type CallerStamp,
  type ClaimResult,
  type ClaimView,
  type Conflict,
  type Grant,
  type Intent,
  type RejoinResult,
  type ReleaseResult,
  type WireRecord,
  ZooError,
} from "./types.ts";

const execFileP = promisify(execFile);

export const PROTOCOL_VERSION = "2024-11-05";
export const REQUIRED_TOOLS = [
  "claim_files",
  "list_claims",
  "register_agent",
  "rejoin_agent",
  "post_intention",
  "update_post",
  "list_posts",
  "get_audit_log",
] as const;

export interface ZooPin {
  /** Absolute path of the real binary (not the npm wrapper). */
  binary: string;
  /** e.g. "0.1.3" — `--version` must print `zoanthrope <version>`. */
  version: string;
  /** Hex SHA-256 of the binary; mismatch is a hard failure when provided. */
  sha256?: string;
}

export interface BinaryIdentity {
  path: string;
  version: string;
  sha256: string;
}

/** G0: the binary we are about to run is the one we pinned. */
export async function verifyBinary(pin: ZooPin): Promise<BinaryIdentity> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(pin.binary, ["--version"], { timeout: 5_000 }));
  } catch (e) {
    throw new ZooError("SPAWN_FAILED", `cannot run ${pin.binary} --version`, String(e));
  }
  const expected = `zoanthrope ${pin.version}`;
  if (stdout.trim() !== expected) {
    throw new ZooError("VERSION_MISMATCH", `expected "${expected}", got "${stdout.trim()}"`);
  }
  const sha256 = createHash("sha256")
    .update(await readFile(pin.binary))
    .digest("hex");
  if (pin.sha256 && pin.sha256 !== sha256) {
    throw new ZooError("VERSION_MISMATCH", `sha256 mismatch: expected ${pin.sha256}, got ${sha256}`);
  }
  return { path: pin.binary, version: pin.version, sha256 };
}

export interface ClaimOptions {
  purpose?: string;
  stamps?: CallerStamp[];
  /** Ask Zoanthrope to refuse if the file changed under our own claim. */
  staleCheck?: boolean;
}

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv;
  callTimeoutMs?: number;
  killGraceMs?: number;
  onWire?: (r: WireRecord) => void;
}

export class ZooAdapter {
  readonly #t: ZooTransport;
  readonly identity: BinaryIdentity | null;
  serverVersion: string | null = null;

  /** Use `ZooAdapter.open` in production; the constructor exists so tests can inject a transport. */
  constructor(transport: ZooTransport, identity: BinaryIdentity | null = null) {
    this.#t = transport;
    this.identity = identity;
  }

  static async open(pin: ZooPin, workspace: string, opts: AdapterOptions = {}): Promise<ZooAdapter> {
    const identity = await verifyBinary(pin);
    const transport = new ZooTransport({
      command: pin.binary,
      args: ["mcp", "--workspace", workspace],
      cwd: workspace,
      ...opts,
    });
    const a = new ZooAdapter(transport, identity);
    await a.start(pin.version);
    return a;
  }

  /** Handshake + tools/list verification (G1). */
  async start(expectedVersion?: string): Promise<void> {
    const init = (await this.#t.start()) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    await this.#checkHandshake(init, expectedVersion);
  }

  async #checkHandshake(
    init: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } },
    expectedVersion?: string,
  ): Promise<void> {
    if (init.serverInfo?.name !== "zoanthrope") {
      throw new ZooError("VERSION_MISMATCH", `unexpected server ${JSON.stringify(init.serverInfo)}`);
    }
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new ZooError("VERSION_MISMATCH", `protocolVersion ${init.protocolVersion}`);
    }
    this.serverVersion = init.serverInfo.version ?? null;
    if (expectedVersion && this.serverVersion !== expectedVersion) {
      throw new ZooError("VERSION_MISMATCH", `server ${this.serverVersion} != pinned ${expectedVersion}`);
    }
    const listed = (await this.#t.call("tools/list", {})) as { tools?: { name: string }[] };
    const names = new Set((listed.tools ?? []).map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
    if (missing.length) throw new ZooError("VERSION_MISMATCH", `tools missing: ${missing.join(", ")}`);
  }

  get transportState() {
    return this.#t.state;
  }

  // ---- operations ----------------------------------------------------

  /**
   * One all-or-nothing call for the whole set (design §5 step 2, S02).
   * A conflict means NOTHING was granted.
   */
  async claim(
    agent: string,
    files: readonly WorkspacePath[],
    intent: Intent,
    opts: ClaimOptions = {},
  ): Promise<ClaimResult> {
    requireAgent(agent);
    if (files.length === 0) throw new ZooError("MALFORMED", "claim of empty file set");
    const sorted = [...new Set(files)].sort();
    const args: Record<string, unknown> = {
      agent_id: agent,
      mode: "claim",
      intent,
      files: sorted,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    if (opts.stamps?.length) args["stamps"] = opts.stamps;
    if (opts.staleCheck) args["stale_check"] = true;
    const body = await this.#tool("claim_files", args);

    if (body["ok"] === true) {
      const grants = parseGrants(body, sorted, intent);
      return { kind: "granted", agent, grants };
    }
    if (body["ok"] === false) {
      return { kind: "conflict", agent, conflict: parseConflict(body) };
    }
    throw new ZooError("MALFORMED", "claim body has neither ok=true nor ok=false", body);
  }

  async release(agent: string, files: readonly WorkspacePath[]): Promise<ReleaseResult> {
    requireAgent(agent);
    const sorted = [...new Set(files)].sort();
    const body = await this.#tool("claim_files", { agent_id: agent, mode: "release", files: sorted });
    if (body["ok"] !== true || !Array.isArray(body["released"])) {
      throw new ZooError("MALFORMED", "release body", body);
    }
    const released = (body["released"] as unknown[]).map(String).sort();
    let remaining: string[] | null = null;
    try {
      remaining = (await this.listClaims(agent)).map((c) => c.path).sort();
    } catch (e) {
      if (!(e instanceof ZooError)) throw e;
    }
    const stillHeld = remaining ? sorted.filter((p) => remaining.includes(p)) : [];
    return {
      agent,
      requested: sorted,
      released,
      stillHeld,
      fsCleanup: "NOT_ATTESTED",
      registryCleanup: remaining !== null && remaining.length === 0 ? "CLEARED" : "UNVERIFIED",
      remainingOwnClaims: remaining,
    };
  }

  /** Claims held by `agent`, or by everyone when omitted. */
  async listClaims(agent?: string): Promise<ClaimView[]> {
    const body = await this.#tool("list_claims", agent ? { agent_id: agent } : {});
    if (body["ok"] !== true || !Array.isArray(body["claims"])) {
      throw new ZooError("MALFORMED", "list_claims body", body);
    }
    return (body["claims"] as Record<string, unknown>[]).map((c) => ({
      agent: str(c, "agent"),
      path: str(c, "path"),
      intent: intentOf(c["intent"]),
      claimedAt: num(c, "claimed_at"),
      purpose: (c["purpose"] as string | null) ?? null,
      heldByStale: c["held_by_stale"] === true,
      callerStamps: stamps(c["caller_stamps"]),
    }));
  }

  /** Reports; never rewrites and never breaks anyone's claim (design §6). */
  async rejoin(agent: string, files?: readonly WorkspacePath[]): Promise<RejoinResult> {
    requireAgent(agent);
    const body = await this.#tool("rejoin_agent", files ? { agent_id: agent, files: [...files] } : { agent_id: agent });
    if (body["ok"] !== true) throw new ZooError("MALFORMED", "rejoin body", body);
    return {
      agent,
      claimsKept: strArr(body["claims_kept"]),
      claimsAtRisk: strArr(body["claims_at_risk"]),
      viewEpoch: num(body, "view_epoch"),
    };
  }

  /** NB: register_agent takes `name`, not `agent_id` (design §13). */
  async registerAgent(name: string, kind = "synapser"): Promise<{ agentId: string }> {
    requireAgent(name);
    const body = await this.#tool("register_agent", { name, kind });
    if (body["ok"] !== true) throw new ZooError("MALFORMED", "register body", body);
    return { agentId: str(body, "agent_id") };
  }

  async postIntention(agent: string, title: string, note: string, files: readonly WorkspacePath[] = []) {
    const body = await this.#tool("post_intention", { agent_id: agent, title, note, files: [...files] });
    if (body["ok"] !== true) throw new ZooError("MALFORMED", "post body", body);
    return { postId: str(body, "post_id") };
  }

  async auditLog(limit = 200, sinceUnix?: number): Promise<unknown[]> {
    const body = await this.#tool("get_audit_log", { limit, ...(sinceUnix !== undefined ? { since_unix: sinceUnix } : {}) });
    if (body["ok"] !== true || !Array.isArray(body["events"])) throw new ZooError("MALFORMED", "audit body", body);
    return body["events"] as unknown[];
  }

  /**
   * After a TIMEOUT/TRANSPORT_CLOSED the effect of the in-flight call is unknown.
   * Restart the process (exit already confirmed by the transport) and return the
   * registry as observed so the executor can reconcile its journal against it.
   * Does NOT release or steal anything.
   */
  async reconcile(): Promise<{ claims: ClaimView[]; generation: number }> {
    const init = (await this.#t.restart()) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    await this.#checkHandshake(init, this.identity?.version);
    return { claims: await this.listClaims(), generation: this.#t.generation };
  }

  async close(): Promise<void> {
    await this.#t.stop();
  }

  // ---- internals -----------------------------------------------------

  async #tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = (await this.#t.call("tools/call", { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = res?.content?.[0]?.text;
    if (typeof text !== "string") throw new ZooError("MALFORMED", `${name}: no content[0].text`, res);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ZooError("MALFORMED", `${name}: content text is not JSON`, text);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ZooError("MALFORMED", `${name}: body is not an object`, body);
    }
    if (res.isError) {
      throw new ZooError("TOOL_ERROR", `${name}: ${(body as { error?: string }).error ?? "isError=true"}`, body);
    }
    return body as Record<string, unknown>;
  }
}

// ---- parsing helpers --------------------------------------------------

function requireAgent(a: string): void {
  if (!a || /\s/.test(a)) throw new ZooError("MALFORMED", `invalid agent id ${JSON.stringify(a)}`);
}
function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new ZooError("MALFORMED", `field ${k} is not a string`, o);
  return v;
}
function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number") throw new ZooError("MALFORMED", `field ${k} is not a number`, o);
  return v;
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ZooError("MALFORMED", "expected string array", v);
  return v.map(String);
}
function intentOf(v: unknown): Intent {
  if (v === "read" || v === "edit") return v;
  throw new ZooError("MALFORMED", `unknown intent ${JSON.stringify(v)}`);
}
function stamps(v: unknown): CallerStamp[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ZooError("MALFORMED", "caller_stamps not an array", v);
  return v.map((s) => ({ name: String((s as CallerStamp).name), value: String((s as CallerStamp).value) }));
}

function parseGrants(body: Record<string, unknown>, requested: string[], intent: Intent): Grant[] {
  if (!Array.isArray(body["granted"])) throw new ZooError("MALFORMED", "ok=true without granted[]", body);
  const grants = (body["granted"] as Record<string, unknown>[]).map(
    (g): Grant => ({
      path: str(g, "path") as WorkspacePath,
      intent: intentOf(g["intent"]),
      claimedAt: num(g, "claimed_at"),
      purpose: (g["purpose"] as string | null) ?? null,
      callerStamps: stamps(g["caller_stamps"]),
    }),
  );
  const got = grants.map((g) => g.path).sort();
  const same = got.length === requested.length && got.every((p, i) => p === requested[i]);
  if (!same) {
    throw new ZooError("PROTOCOL_VIOLATION", `granted set != requested set`, { requested, got });
  }
  // A re-claim never weakens an existing stronger intent, so a read request may legitimately
  // come back as "edit" if we already held edit. The reverse would be a bug.
  for (const g of grants) {
    if (intent === "edit" && g.intent !== "edit") {
      throw new ZooError("PROTOCOL_VIOLATION", `edit requested but ${g.path} granted as ${g.intent}`);
    }
  }
  return grants;
}

function parseConflict(body: Record<string, unknown>): Conflict {
  const holder = body["holder"];
  const path = body["path"];
  if (typeof holder !== "string" || typeof path !== "string") {
    throw new ZooError("MALFORMED", "refusal without holder/path", body);
  }
  return {
    holder,
    path,
    holderStale: body["holder_stale"] === true,
    intent: intentOf(body["intent"] ?? "edit"),
    purpose: (body["purpose"] as string | null) ?? null,
    claimedAt: typeof body["claimed_at"] === "number" ? body["claimed_at"] : null,
    reason: typeof body["reason"] === "string" ? body["reason"] : null,
    callerStamps: stamps(body["caller_stamps"]),
    raw: body,
  };
}
