// Synapser as an MCP server (plan 13 §3). Newline-delimited JSON-RPC over stdio. The protocol is the official SDK's
// (plan 16, P16.2); the tools are ours.
//
// Trust model:
//   M1 a `worker` session has no approval tools; M2 the ROLE is fixed by whoever launched this process,
//   never by the client's `initialize`; M3 every call is a ledger event with the caller's identity;
//   M4 read-only tools write nothing except their own call record.
// The approval CODE (plan 13 E2) is never produced by any tool: it is only visible on human channels.

import { createHash } from "node:crypto";
import { InMemoryTransport, type JSONRPCMessage, Server } from "@modelcontextprotocol/server";
import type { ProfileCard } from "../orchestration/catalog.ts";
import { currentPlanDigest, decideApproval, isSelfBound, pendingGates } from "../orchestration/gates.ts";
import type { Journal } from "../journal/journal.ts";
import type { Actor, WorkflowManager } from "../workflow/manager.ts";
import type { LibraryStore } from "../library/store.ts";
import { taskRecipeSchema, type TaskRecipe } from "../library/schema.ts";

export type McpRole = "initiator" | "worker";

export interface McpSession {
  id: string;
  role: McpRole;
  /** `clientInfo.name` from initialize: a coarse owner key, NOT an authenticated identity. */
  client: string;
}

interface Tool {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  description: string;
  roles: readonly McpRole[];
  readOnly: boolean;
  inputSchema: { type: "object"; [key: string]: unknown };
  run(args: Record<string, unknown>, s: McpSession): Promise<unknown> | unknown;
}

const str = (d: string, extra: Record<string, unknown> = {}) => ({ type: "string", description: d, ...extra });

/** The params of a tools/call as the client sent them: nothing is assumed until #call checks them. */
type CallParams = { name?: unknown; arguments?: unknown };

/** A message as a client sent it. Nothing is read from it before it has been checked. A client may also send a reply. */
type Incoming = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

/** JSON-RPC params are an object, or none. The SDK does not answer a request whose params are anything else, and the
 *  hand-written server ignored them, so anything else is dropped. */
function objectParams(params: unknown): Record<string, unknown> | undefined {
  return typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : undefined;
}

/** What the SDK needs from an initialize, and what the hand-written server did without: a protocol revision (2024-11-05,
 *  the one it always answered), and a clientInfo with a name and a version. The client's values win. The client's
 *  capabilities are not sent: this server reads none of them, and the SDK refuses some odd values the server accepted. */
function initializeFields(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const ci = objectParams(params?.["clientInfo"]) ?? {};
  return {
    protocolVersion: typeof params?.["protocolVersion"] === "string" ? params["protocolVersion"] : "2024-11-05",
    capabilities: {},
    clientInfo: { ...ci, name: typeof ci["name"] === "string" ? ci["name"] : "unknown", version: typeof ci["version"] === "string" ? ci["version"] : "unknown" },
  };
}

/** Methods whose params the hand-written server never read. The SDK would refuse some of them (a tools/list cursor that
 *  is not a string), and the answer does not depend on them, so they are not sent. */
const UNREAD_PARAMS = new Set(["ping", "tools/list"]);

/** The message as the SDK reads it. The hand-written server never checked jsonrpc, so it is set to 2.0 here. */
function toSdk(msg: Incoming, keepId: boolean): JSONRPCMessage {
  const params = objectParams(msg.params);
  const body = msg.method === "initialize" ? { ...params, ...initializeFields(params) } : UNREAD_PARAMS.has(msg.method as string) ? undefined : params;
  return {
    jsonrpc: "2.0",
    method: msg.method as string,
    ...(keepId ? { id: msg.id as string | number } : {}),
    ...(body === undefined ? {} : { params: body }),
  } as JSONRPCMessage;
}

export interface McpOptions {
  manager: WorkflowManager;
  role?: McpRole;
  /** A `worker` session belongs to ONE workflow/task; it can touch nothing else (plan 13 §3, M1). */
  bound?: { workflowId: string; taskId: string };
  catalog?: () => ProfileCard[];
  policy?: () => unknown;
  library?: LibraryStore;
  /** Journal for calls that belong to no workflow (list, catalog). */
  serverJournal: Journal;
  version?: string;
  /** How long a request may wait for the protocol layer before it is answered with an error. A guard against one
   *  unanswered request freezing the whole connection (plan 16, P16.2); well-formed traffic never reaches it. */
  answerTimeoutMs?: number;
}

export class McpServer {
  readonly #o: McpOptions;
  readonly #tools: Tool[];
  readonly #sdk: Server;
  readonly #client: InMemoryTransport;
  readonly #ready: Promise<void>;
  readonly #answerMs: number;
  /** Replies still owed to `handle`, by request id. */
  readonly #waiting = new Map<unknown, (reply: Record<string, unknown>) => void>();
  #session: McpSession;
  #n = 0;

  constructor(o: McpOptions) {
    this.#o = o;
    this.#session = { id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, role: o.role ?? "initiator", client: "unknown" };
    this.#tools = this.#buildTools();
    this.#answerMs = o.answerTimeoutMs ?? 10_000;
    // The SDK answers the lifecycle (initialize with revision negotiation, ping, notifications) and the method errors.
    // The tool handlers stay ours, so the trust rules and the ledger record of every call are unchanged.
    this.#sdk = new Server({ name: "synapser", version: o.version ?? "0.1.0" }, { capabilities: { tools: {} } });
    this.#sdk.setRequestHandler("tools/list", () => ({ tools: this.#listed() }));
    const [client, server] = InMemoryTransport.createLinkedPair();
    this.#client = client;
    this.#client.onmessage = (message) => this.#deliver(message as unknown as Record<string, unknown>);
    this.#ready = this.#sdk.connect(server).then(() => this.#client.start());
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
        name: "advise", roles: ["initiator"], readOnly: false,
        description: "Ask Synapser's advisor (Nemotron) about a workflow. It answers and may PROPOSE interventions (inject a note, hold, escalate, replan, rollback). Nothing is applied by asking.",
        inputSchema: { type: "object", required: ["workflow_id", "question"], properties: { workflow_id: wfId, question: str("What you want to know or decide.") } },
        run: async (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          const adv = m.advisorOf(id);
          if (!adv) return { error: "ADVISOR_UNAVAILABLE" };
          const out = await adv.consult({ kind: "ask", question: String(a["question"]).slice(0, 600) }, false);
          return {
            assessment: out.assessment,
            proposals: out.records.map((r) => ({ intervention_id: r.id, type: r.type, task: r.task, state: r.state, why: (r.body as { why?: string }).why ?? "", reason: r.reason })),
          };
        },
      },
      {
        name: "intervention_list", roles: ["initiator"], readOnly: true,
        description: "The advisor's interventions on a workflow and their state.",
        inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: wfId } },
        run: (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          return { interventions: (m.advisorOf(id)?.list() ?? []).map((r) => ({ intervention_id: r.id, type: r.type, task: r.task, state: r.state, trigger: r.trigger, reason: r.reason })) };
        },
      },
      {
        name: "intervention_apply", roles: ["initiator"], readOnly: false,
        description: "Apply a PROPOSED intervention. A rollback is destructive: it opens a human gate (code required) instead of running.",
        inputSchema: { type: "object", required: ["workflow_id", "intervention_id"], properties: { workflow_id: wfId, intervention_id: str("iv-…") } },
        run: async (a, s) => {
          const id = this.#scope(a, s);
          if (typeof id !== "string") return id;
          const r = await m.advisorOf(id)?.applyProposed(String(a["intervention_id"]), `${s.client}#${s.id}`);
          return r?.ok ? { ok: true } : { error: r?.reason ?? "ADVISOR_UNAVAILABLE" };
        },
      },
      {
        name: "catalog_list", roles: ["initiator"], readOnly: true,
        description: "The agents Synapser can use: what each can do, its cost basis and availability.",
        inputSchema: { type: "object", properties: {} },
        run: () => ({
          profiles: (this.#o.catalog?.() ?? []).map((c) => ({ id: c.id, kinds: c.kinds, enabled: c.enabled, integration: c.integration, strengths: c.strengths, cost: c.cost, observed: c.observed })),
        }),
      },
      {
        name: "task_catalog", title: "Published task recipes", annotations: { readOnlyHint: true }, roles: ["initiator"], readOnly: true,
        description: "List operator-published task recipes. Draft and unpublished library entries are never exposed here.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: () => ({ recipes: (this.#o.library?.publishedRecipes() ?? []).flatMap((entry) => {
          const recipe = taskRecipeSchema.safeParse(entry.document);
          return recipe.success ? [{ id: entry.id, digest: entry.digest, title: recipe.data.title, description: recipe.data.description, category: recipe.data.category, parameters: recipe.data.parameters, requiredCapabilities: recipe.data.requiredCapabilities, requiredSkills: recipe.data.requiredSkills, requiredMcpServers: recipe.data.requiredMcpServers, startPolicy: recipe.data.startPolicy }] : [];
        }) }),
      },
      {
        name: "task_request", title: "Request a task from a recipe", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, roles: ["initiator"], readOnly: false,
        description: "Resolve an operator-published recipe and create a parameterized workflow DRAFT. Parameters are substituted into and stored with that draft; never submit secrets. This tool never starts it.",
        inputSchema: { type: "object", required: ["recipe_id", "params"], additionalProperties: false, properties: { recipe_id: str("Published recipe id."), params: { type: "object", additionalProperties: true } } },
        run: (a, s) => this.#requestTask(a, s),
      },
    ];
  }

  #requestTask(args: Record<string, unknown>, session: McpSession): unknown {
    const recipeId = args["recipe_id"];
    const params = args["params"];
    if (Object.keys(args).some((key) => !["recipe_id", "params"].includes(key)) || typeof recipeId !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return { error: "INVALID_REQUEST" };
    const entry = this.#o.library?.publishedRecipes().find((candidate) => candidate.id === recipeId);
    if (!entry) return { error: "UNKNOWN_PUBLISHED_RECIPE" };
    const checkedRecipe = taskRecipeSchema.safeParse(entry.document);
    if (!checkedRecipe.success) return { error: "PUBLISHED_RECIPE_INVALID" };
    const recipe = checkedRecipe.data;
    const resolved = resolveRecipeParameters(recipe, params as Record<string, unknown>);
    if (!resolved.ok) return { error: "INVALID_PARAMETERS", errors: resolved.errors };
    const requiredSkills = recipe.requiredSkills.filter((skill) => skill.required);
    const absentSkills = requiredSkills.filter((skill) => !this.#o.library?.get("skills", skill.id)).map((skill) => skill.id);
    const missingMcps = recipe.requiredMcpServers;
    const profileKind = recipe.category === "implementation" ? "write" : recipe.category === "research" ? "research" : recipe.category === "alternatives" ? "advise" : "review";
    const cards = this.#o.catalog?.() ?? [];
    const compatible = cards.filter((card) => card.enabled && card.kinds.includes(profileKind) && recipe.requiredCapabilities.every((capability) => card.capabilities.capabilityIds.includes(capability))
      && requiredSkills.every((skill) => card.allowedSkillIds.includes(skill.id) && card.capabilities.skills !== "none"));
    const resolution = {
      profiles: compatible.map((card) => ({ id: card.id, cost: card.cost, integration: card.integration })),
      profileAssignment: "candidate profiles only; no profile is bound until workflow execution",
      category: { recipe: recipe.category, profileKind, enforced: false },
      capabilities: { required: recipe.requiredCapabilities, candidateProfiles: compatible.map((card) => card.id), enforced: false },
      skills: { required: requiredSkills.map((skill) => skill.id), optionalNotSelected: recipe.requiredSkills.filter((skill) => !skill.required).map((skill) => skill.id), missing: absentSkills, compatibleProfiles: compatible.filter((card) => requiredSkills.every((skill) => card.allowedSkillIds.includes(skill.id))).map((card) => card.id), assignment: "workflow execution does not yet bind recipe skills to a selected profile" },
      mcpServers: { required: missingMcps, available: [], missing: missingMcps },
      cost: compatible.map((card) => ({ profile: card.id, estimate: card.cost })),
      costLimit: "profile costs are estimates; recipe-level USD is not enforced by the workflow runtime",
      disclosure: "not configured",
    };
    if (absentSkills.length || missingMcps.length || compatible.length === 0 || requiredSkills.length > 0 || recipe.requiredCapabilities.length > 0) return { error: "RECIPE_UNRESOLVED", resolution };
    if (recipe.startPolicy !== "draft") return { error: "START_POLICY_UNSUPPORTED", policy: recipe.startPolicy, detail: "recipe-specific start gates and enforced execution bounds are not available; only draft recipes can be requested", resolution };
    if (recipe.workflow.budget?.usd !== undefined) return { error: "RECIPE_BUDGET_UNSUPPORTED", detail: "recipe-level USD budgets are not enforced by the workflow runtime; remove the USD budget or use an enforced time limit", resolution };
    let workflow: TaskRecipe["workflow"];
    try {
      workflow = substituteRecipe(recipe.workflow, resolved.values);
    } catch {
      return { error: "INVALID_RECIPE_TEMPLATE" };
    }
    const created = this.#o.manager.create(workflow, this.#actor(session));
    if (!created.ok) return { error: created.code, errors: created.errors };
    const paramsDigest = createHash("sha256").update(JSON.stringify(resolved.values)).digest("hex");
    const journal = this.#o.manager.journalOf(created.id);
    journal?.tx((tx) => tx.event(created.id, "recipe_request", recipeId, null, "DRAFT", {
      recipe_id: recipeId, recipe_digest: entry.digest, params_digest: paramsDigest, parameter_names: Object.keys(resolved.values).sort(),
    }));
    return { workflow_id: created.id, state: "DRAFT", recipe: { id: recipeId, digest: entry.digest }, parameter_names: Object.keys(resolved.values).sort(), resolution };
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

  /** One message in, its reply out (null for a notification). Only a request with a string method and an id the
   *  protocol can answer reaches the SDK; the rest is answered here, as the hand-written server answered it. */
  async handle(msg: Incoming): Promise<Record<string, unknown> | null> {
    await this.#ready;
    const { id } = msg;
    if (typeof msg.method !== "string") {
      return id === undefined ? null : { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
    }
    // tools/call is answered here, not by the SDK: the SDK checks its params before our code runs, which would keep a
    // nameless call out of the ledger (M3), and it cannot express the -32002 of an uninitialized session.
    if (msg.method === "tools/call") return this.#callReply(msg);
    // a notification has no id; one that carries an id is still a notification, and gets no reply
    if (id === undefined || msg.method.startsWith("notifications/")) {
      await this.#client.send(toSdk(msg, false));
      return null;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: id must be a string or a number" } };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32603, message: "no answer from the protocol layer" } });
      }, this.#answerMs);
      this.#waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      void this.#client.send(toSdk(msg, true));
    });
  }

  #deliver(message: Record<string, unknown>): void {
    const wait = this.#waiting.get(message["id"]);
    if (!wait) return;
    this.#waiting.delete(message["id"]);
    wait(message);
  }

  #listed() {
    return this.#tools.filter((t) => t.roles.includes(this.#session.role)).map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, ...(t.annotations ? { annotations: t.annotations } : {}), inputSchema: t.inputSchema }));
  }

  async #callReply(msg: Incoming): Promise<Record<string, unknown>> {
    const id = (msg.id ?? null) as number | string | null;
    if (!this.#sdk.getClientVersion()) return { jsonrpc: "2.0", id, error: { code: -32002, message: "server not initialized" } };
    return { jsonrpc: "2.0", id, result: await this.#call((msg.params ?? {}) as CallParams) };
  }

  async #call(request: CallParams): Promise<Record<string, unknown>> {
    // M2: the client NAME comes from the SDK's initialize, trimmed and cut as before; the role never does.
    const raw = this.#sdk.getClientVersion()?.name?.trim() ?? "";
    if (raw) this.#session = { ...this.#session, client: raw.slice(0, 60) };
    const name = String(request.name ?? "");
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    const tool = this.#tools.find((t) => t.name === name);
    const wf = typeof args["workflow_id"] === "string" ? (args["workflow_id"] as string) : null;
    if (!tool || !tool.roles.includes(this.#session.role)) {
      this.#record(name || "(unknown)", args, false, wf && this.#o.manager.status(wf) ? wf : null);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "UNKNOWN_TOOL", tool: name }) }] };
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
    return { isError: failed, content: [{ type: "text", text: JSON.stringify(out) }] };
  }
}

/** Serve one session over a pair of streams (stdin/stdout in production). */
export function serveStdio(server: { handle(msg: Incoming): Promise<Record<string, unknown> | null> }, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
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

function resolveRecipeParameters(recipe: TaskRecipe, input: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  const definitions = new Map(recipe.parameters.map((parameter) => [parameter.name, parameter]));
  for (const key of Object.keys(input)) if (!definitions.has(key)) errors.push(`unexpected parameter: ${key}`);
  for (const parameter of recipe.parameters) {
    let value = input[parameter.name];
    if (value === undefined) {
      if (Object.hasOwn(parameter, "default")) value = parameter.default;
      else if (parameter.required) { errors.push(`missing required parameter: ${parameter.name}`); continue; }
      else continue;
    }
    let valid = false;
    switch (parameter.type) {
      case "string": valid = typeof value === "string" && value.trim().length > 0 && (parameter.maxLength === undefined || value.length <= parameter.maxLength); break;
      case "string_list": valid = Array.isArray(value) && value.every((item) => typeof item === "string") && (parameter.maxItems === undefined || value.length <= parameter.maxItems); break;
      case "integer": valid = typeof value === "number" && Number.isSafeInteger(value) && (parameter.minimum === undefined || value >= parameter.minimum) && (parameter.maximum === undefined || value <= parameter.maximum); break;
      case "boolean": valid = typeof value === "boolean"; break;
      case "enum": valid = typeof value === "string" && parameter.options.includes(value); break;
    }
    if (!valid) errors.push(`invalid value for parameter: ${parameter.name}`);
    else values[parameter.name] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/** Interpolation is intentionally restricted to strings and declared parameter names; no eval or object-path lookup. */
function substituteRecipe<T>(value: T, params: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-z][a-z0-9_-]{0,62})\}\}/g, (_match, key: string) => {
      if (!Object.hasOwn(params, key)) throw new Error(`recipe contains unresolved parameter ${key}`);
      const replacement = params[key];
      return Array.isArray(replacement) ? replacement.join("\n") : String(replacement);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => substituteRecipe(item, params)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, substituteRecipe(child, params)])) as T;
  return value;
}
