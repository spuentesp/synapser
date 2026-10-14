// Synapser as an MCP server (plan 13 §3). Newline-delimited JSON-RPC over stdio, protocol 2024-11-05.
//
// Trust model:
//   M1 a `worker` session has no approval tools; M2 the ROLE is fixed by whoever launched this process,
//   never by the client's `initialize`; M3 every call is a ledger event with the caller's identity;
//   M4 read-only tools write nothing except their own call record.
// The approval CODE (plan 13 E2) is never produced by any tool: it is only visible on human channels.

import { createHash } from "node:crypto";
import type { ProfileCard } from "../orchestration/catalog.ts";
import { currentPlanDigest, decideApproval, isSelfBound, pendingGates } from "../orchestration/gates.ts";
import type { Journal } from "../journal/journal.ts";
import type { Actor, WorkflowManager } from "../workflow/manager.ts";

export type McpRole = "initiator" | "worker";

export interface McpSession {
  id: string;
  role: McpRole;
  /** `clientInfo.name` from initialize: a coarse owner key, NOT an authenticated identity. */
  client: string;
}

interface Tool {
  name: string;
  description: string;
  roles: readonly McpRole[];
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, s: McpSession): Promise<unknown> | unknown;
}

const PROTOCOL = "2024-11-05";
const str = (d: string, extra: Record<string, unknown> = {}) => ({ type: "string", description: d, ...extra });

export interface McpOptions {
  manager: WorkflowManager;
  role?: McpRole;
  /** A `worker` session belongs to ONE workflow/task; it can touch nothing else (plan 13 §3, M1). */
  bound?: { workflowId: string; taskId: string };
  catalog?: () => ProfileCard[];
  policy?: () => unknown;
  /** Journal for calls that belong to no workflow (list, catalog). */
  serverJournal: Journal;
  version?: string;
}

export class McpServer {
  readonly #o: McpOptions;
  readonly #tools: Tool[];
  #session: McpSession;
  #n = 0;
  #initialized = false;

  constructor(o: McpOptions) {
    this.#o = o;
    this.#session = { id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, role: o.role ?? "initiator", client: "unknown" };
    this.#tools = this.#buildTools();
  }

  get session(): McpSession {
    return this.#session;
  }

  // ---- tools -----------------------------------------------------------------------------------

  #actor(s: McpSession): Actor {
    return { id: `${s.client}#${s.id}`, role: "initiator" };
  }

  /** A caller may act on workflows its client created; the operator (CLI/UI) acts on all. */
  /** Resolve the workflow an effect tool acts on, enforcing ownership (initiator) or binding (worker). */
  #scope(a: Record<string, unknown>, s: McpSession): string | { error: string } {
    const bound = this.#o.bound;
    const id = String(a["workflow_id"] ?? bound?.workflowId ?? "");
    if (s.role === "worker") return bound && id === bound.workflowId ? id : { error: "NOT_YOUR_WORKFLOW" };
    const own = this.#owned(id, s);
    return own.ok ? id : { error: own.error };
  }

  #owned(id: string, s: McpSession): { ok: true } | { ok: false; error: string } {
    const v = this.#o.manager.status(id);
    if (!v) return { ok: false, error: "UNKNOWN_WORKFLOW" };
    const owner = v.createdBy?.split("#")[0];
    return owner === s.client ? { ok: true } : { ok: false, error: "NOT_YOURS" };
  }

  #buildTools(): Tool[] {
    const m = this.#o.manager;
    const wfId = str("The workflow id (wf-…).");
    return [
      {
        name: "workflow_create", roles: ["initiator"], readOnly: false,
        description: "Create a workflow DRAFT: a task with a description, goals, non-goals and acceptance CONDITIONS. It ends when every required condition is satisfied with evidence. Nothing runs until workflow_start.",
        inputSchema: {
          type: "object", required: ["title", "description", "conditions"],
          properties: {
            title: str("Short name."), description: str("What must be achieved, in prose."),
            goals: { type: "array", items: { type: "string" } },
            nonGoals: { type: "array", description: "Strings, or {statement, guard} where guard is a diff/file/command checker that detects violation.", items: {} },
            conditions: {
              type: "array", description: "Atomic acceptance conditions: {id, statement, required?, checker:{kind: command|citations|diff|file|approval|review, …}}.",
              items: { type: "object" },
            },
            budget: { type: "object", properties: { usd: { type: "number" }, minutes: { type: "number" } } },
          },
        },
        run: (a, s) => {
          const r = m.create(a, this.#actor(s));
          return r.ok ? { workflow_id: r.id, state: "DRAFT" } : { error: r.code, errors: r.errors };
        },
      },
      {
        name: "workflow_edit", roles: ["initiator"], readOnly: false,
        description: "Replace a workflow's definition with a new revision (conditions included). Allowed until it is terminal; the next DONE is judged against the new set.",
        inputSchema: { type: "object", required: ["workflow_id", "workflow"], properties: { workflow_id: wfId, workflow: { type: "object" } } },
        run: (a, s) => {
          const own = this.#owned(String(a["workflow_id"]), s);
          if (!own.ok) return { error: own.error };
          const r = m.edit(String(a["workflow_id"]), a["workflow"], this.#actor(s));
          return r.ok ? { revision: r.revision } : { error: r.code, errors: r.errors };
        },
      },
      {
        name: "workflow_start", roles: ["initiator"], readOnly: false,
        description: "Start a DRAFT workflow. If the operator's policy requires it, it waits in AWAITING_START for a human decision.",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId } },
        run: (a, s) => {
          const own = this.#owned(String(a["workflow_id"]), s);
          if (!own.ok) return { error: own.error };
          const r = m.start(String(a["workflow_id"]), this.#actor(s));
          return r.ok ? { state: r.state } : { error: r.code };
        },
      },
      {
        name: "workflow_status", roles: ["initiator"], readOnly: true,
        description: "State, revision, each condition's latest status and evidence, and why it failed if it did.",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId } },
        run: (a, s) => {
          const own = this.#owned(String(a["workflow_id"]), s);
          if (!own.ok) return { error: own.error };
          const v = m.status(String(a["workflow_id"]))!;
          return { workflow_id: v.id, state: v.state, reason: v.reason, revision: v.revision, round: v.round, title: v.workflow.title, conditions: v.conditions, events: v.events };
        },
      },
      {
        name: "workflow_list", roles: ["initiator"], readOnly: true,
        description: "Your workflows (created by this client) with their state.",
        inputSchema: { type: "object", properties: {} },
        run: (_a, s) => ({ workflows: m.list().filter((v) => v.createdBy?.split("#")[0] === s.client).map((v) => ({ workflow_id: v.id, title: v.workflow.title, state: v.state })) }),
      },
      {
        name: "workflow_events", roles: ["initiator"], readOnly: true,
        description: "The workflow's ledger events after `since_seq` (hash-chained, deterministic).",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId, since_seq: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } } },
        run: (a, s) => {
          const own = this.#owned(String(a["workflow_id"]), s);
          if (!own.ok) return { error: own.error };
          const limit = typeof a["limit"] === "number" ? (a["limit"] as number) : 200;
          return { events: (m.events(String(a["workflow_id"]), Number(a["since_seq"] ?? 0)) ?? []).slice(0, limit) };
        },
      },
      {
        name: "workflow_cancel", roles: ["initiator"], readOnly: false,
        description: "Cancel a workflow. Running steps are allowed to end; nothing new is admitted.",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId } },
        run: (a, s) => {
          const own = this.#owned(String(a["workflow_id"]), s);
          if (!own.ok) return { error: own.error };
          const r = m.cancel(String(a["workflow_id"]), this.#actor(s));
          return r.ok ? { state: r.state } : { error: r.code };
        },
      },
      {
        name: "gate_list", roles: ["initiator"], readOnly: true,
        description: "Pending human decisions on your workflows (start, steps, conditions). The approval CODE is not shown here: the operator reads it in the UI or console and gives it to you.",
        inputSchema: { type: "object", properties: { workflow_id: wfId } },
        run: (a, s) => {
          const out: unknown[] = [];
          for (const v of m.list().filter((x) => x.createdBy?.split("#")[0] === s.client && (!a["workflow_id"] || x.id === a["workflow_id"]))) {
            for (const g of this.#pending(m.journalOf(v.id)!)) out.push({ workflow_id: v.id, gate: g.key, kind: g.kind, summary: g.why, since_seq: g.seq });
          }
          return { gates: out };
        },
      },
      {
        name: "gate_approve", roles: ["initiator"], readOnly: false,
        description: "Relay a human's approval. REQUIRES `code`: the one-time code shown to the operator in the UI or console. Without the human's code this fails: an agent cannot approve its own gate.",
        inputSchema: { type: "object", required: ["workflow_id", "gate", "code"], properties: { workflow_id: wfId, gate: str("Gate key from gate_list."), code: str("The operator's one-time code."), reason: str("Optional note.") } },
        run: (a, s) => this.#decide(a, s, "APPROVED"),
      },
      {
        name: "gate_reject", roles: ["initiator"], readOnly: false,
        description: "Relay a human's rejection of a gate. Same code requirement as gate_approve.",
        inputSchema: { type: "object", required: ["workflow_id", "gate", "code"], properties: { workflow_id: wfId, gate: str("Gate key."), code: str("The operator's one-time code."), reason: str("Optional note.") } },
        run: (a, s) => this.#decide(a, s, "REJECTED"),
      },
      {
        name: "effect_request", roles: ["initiator", "worker"], readOnly: false,
        description: "Ask Synapser to perform a side effect you cannot (git.commit, git.push, gh.pr, http.request). Policy decides allow/ask/deny; with `ask` a human must approve what the system computes (not what you describe). Returns PENDING — nothing happens until then.",
        inputSchema: {
          type: "object", required: ["workflow_id", "kind", "params"],
          properties: { workflow_id: wfId, kind: str("e.g. git.push"), params: { type: "object" }, why: str("Why — recorded as your assertion, never as evidence.") },
        },
        run: async (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          const b = m.effects(id);
          if (!b) return { error: "UNKNOWN_WORKFLOW" };
          const r = await b.request({ kind: String(a["kind"]), params: a["params"], requestedBy: `${s.client}#${s.id}`, taskId: this.#o.bound?.taskId ?? null });
          return r.ok ? { effect_id: r.id, state: r.state, decision: r.decision, summary: r.summary, rule: r.rule } : { error: r.code, errors: r.errors };
        },
      },
      {
        name: "effect_status", roles: ["initiator", "worker"], readOnly: true,
        description: "State, summary and evidence of an effect (PENDING, DONE, DENIED, STALE, EXPIRED, FAILED).",
        inputSchema: { type: "object", required: ["workflow_id", "effect_id"], properties: { workflow_id: wfId, effect_id: str("ef-…") } },
        run: (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          const st = m.effects(id)?.status(String(a["effect_id"]));
          return st ? { effect_id: st.id, kind: st.kind, state: st.state, summary: st.summary, reason: st.reason, evidence: st.evidence, rule: st.rule } : { error: "UNKNOWN_EFFECT" };
        },
      },
      {
        name: "effect_list", roles: ["initiator"], readOnly: true,
        description: "Effects requested in a workflow, with their state.",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId } },
        run: (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          return { effects: (m.effects(id)?.records() ?? []).map((r) => ({ effect_id: r.id, kind: r.kind, state: r.state, summary: r.summary, rule: r.rule })) };
        },
      },
      {
        name: "policy_show", roles: ["initiator"], readOnly: true,
        description: "The effect policy in force: which kinds are allowed, asked or denied.",
        inputSchema: { type: "object", properties: {} },
        run: () => this.#o.policy?.() ?? { error: "NO_POLICY" },
      },
      {
        name: "catalog_list", roles: ["initiator"], readOnly: true,
        description: "The agents Synapser can use: what each can do, its cost basis and availability.",
        inputSchema: { type: "object", properties: {} },
        run: () => ({
          profiles: (this.#o.catalog?.() ?? []).map((c) => ({ id: c.id, kinds: c.kinds, enabled: c.enabled, integration: c.integration, strengths: c.strengths, cost: c.cost, observed: c.observed })),
        }),
      },
    ];
  }

  #pending(j: Journal) {
    return pendingGates(j);
  }

  #decide(a: Record<string, unknown>, s: McpSession, decision: "APPROVED" | "REJECTED"): unknown {
    const id = String(a["workflow_id"]);
    const own = this.#owned(id, s);
    if (!own.ok) return { error: own.error };
    const j = this.#o.manager.journalOf(id)!;
    const gate = this.#pending(j).find((g) => g.key === String(a["gate"]));
    if (!gate) return { error: "NO_SUCH_PENDING_GATE" };
    const r = decideApproval(j, id, {
      taskId: gate.key, planDigest: gate.digest, currentDigest: isSelfBound(gate.key) ? gate.digest : currentPlanDigest(j),
      decision, actor: `${s.client}#${s.id}`, channel: "mcp", challenge: String(a["code"] ?? ""),
      ...(typeof a["reason"] === "string" ? { reason: a["reason"] as string } : {}),
    });
    return r.ok ? { ok: true, gate: gate.key, decision } : { error: r.code };
  }

  // ---- protocol --------------------------------------------------------------------------------

  /** Every call is a ledger event with who asked (M3). Arguments are recorded by digest and key names:
   *  a `code` must never be readable from the ledger. */
  #record(tool: string, args: Record<string, unknown>, ok: boolean, workflowId: string | null): void {
    const j = (workflowId ? this.#o.manager.journalOf(workflowId) : null) ?? this.#o.serverJournal;
    const digest = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => k !== "code")))).digest("hex").slice(0, 16);
    j.tx((t) =>
      t.event(j.runId, "mcp_call", `${this.#session.id}:${++this.#n}`, null, tool, {
        role: this.#session.role, client: this.#session.client, ok, args_digest: digest, arg_keys: Object.keys(args).sort(),
      }),
    );
  }

  async handle(msg: { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
    const id = msg.id ?? null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const ci = (msg.params?.["clientInfo"] ?? {}) as { name?: unknown };
        // M2: only the client NAME is taken from the caller; its role never is.
        if (typeof ci.name === "string" && ci.name.trim()) this.#session = { ...this.#session, client: ci.name.trim().slice(0, 60) };
        this.#initialized = true;
        return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "synapser", version: this.#o.version ?? "0.1.0" } });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: this.#tools.filter((t) => t.roles.includes(this.#session.role)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        if (!this.#initialized) return error(-32002, "server not initialized");
        const name = String(msg.params?.["name"] ?? "");
        const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
        const tool = this.#tools.find((t) => t.name === name);
        const wf = typeof args["workflow_id"] === "string" ? (args["workflow_id"] as string) : null;
        if (!tool || !tool.roles.includes(this.#session.role)) {
          this.#record(name || "(unknown)", args, false, wf && this.#o.manager.status(wf) ? wf : null);
          return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "UNKNOWN_TOOL", tool: name }) }] });
        }
        let out: unknown;
        try {
          out = await tool.run(args, this.#session);
        } catch (e) {
          out = { error: "INTERNAL", detail: String((e as Error).message ?? e).slice(0, 200) };
        }
        const failed = typeof out === "object" && out !== null && "error" in out;
        // a creation belongs to the workflow it just made
        const made = typeof out === "object" && out !== null && typeof (out as { workflow_id?: unknown }).workflow_id === "string" ? (out as { workflow_id: string }).workflow_id : null;
        const target = wf ?? made;
        this.#record(name, args, !failed, target && this.#o.manager.status(target) ? target : null);
        return reply({ isError: failed, content: [{ type: "text", text: JSON.stringify(out) }] });
      }
      default:
        return msg.id === undefined ? null : error(-32601, `method not found: ${String(msg.method)}`);
    }
  }
}

/** Serve one session over a pair of streams (stdin/stdout in production). */
export function serveStdio(server: McpServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let chain = Promise.resolve();
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        chain = chain.then(async () => {
          let msg: Parameters<McpServer["handle"]>[0];
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
            return;
          }
          const res = await server.handle(msg);
          if (res) output.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
    input.on("end", () => void chain.then(() => resolve()));
  });
}
