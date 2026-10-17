// Read-mostly HTTP API over the ledger (plan 12). It imports the journal, the audit queries and the
// approval gate — NOT the executor: nothing here can touch the workspace (U1). The single write is an
// approval decision, an event on the ledger bound to the current plan digest (U4).
//
//   GET  /api/session                      { ok, mode, needsCode }; sets the session cookie (HttpOnly, SameSite=Strict).
//                                          Never the token itself. In adversarial mode the cookie waits for the code.
//   POST /api/session/redeem               { code }; adversarial mode only: one use, five failures at most, same origin
//   GET  /api/runs                         runs found under the state dir
//   GET  /api/runs/:id/state[?seq=N]       swarm state (replayable at any seq)
//   GET  /api/runs/:id/{timeline,cost,waste,coordination,verify,export}
//   GET  /api/runs/:id/why?action=ID       declared chain + the agent's own words (labelled)
//   GET  /api/runs/:id/events?since=SEQ    Server-Sent Events: the ledger as it grows
//   POST /api/runs/:id/approvals/:task     { decision, actor, planDigest }  header x-synapser-token
//   GET  /api/library[/:kind[/:id]]        the operator library, versioned (plan 14 Q2.6)
//   PUT|DELETE /api/library/:kind/:id      token + same origin; an invalid document is refused whole

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coordination, costBy, exportLedger, orchestrationCost, timeline, verify, waste, whoChanged, why } from "../audit/queries.ts";
import { swarmState } from "../audit/state.ts";
import type { ChatService } from "../chat/chat.ts";
import type { AgentTrialInput, AgentTrialResult } from "../agents/trial.ts";
import { Journal } from "../journal/journal.ts";
import { libraryRoute, reviewingWorkflows, withLibraryProviders } from "./library.ts";
import { fail, json, OPERATOR, readBody } from "./http.ts";
import { type LibraryStore } from "../library/store.ts";
import { type LibraryPolicy, NO_LIBRARY_POLICY } from "../library/validate.ts";
import type { WorkflowManager } from "../workflow/manager.ts";
import { currentPlanDigest, decideApproval, isSelfBound, pendingApprovals, pendingGates, readChallenge } from "../orchestration/gates.ts";
import type { McpServerRegistration } from "../mcp/registry.ts";
import type { McpServerDiscovery } from "../mcp/discovery.ts";

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const APPROVAL_KEY = /^(?:[A-Za-z0-9._-]{1,80}|(?:cond|effect|iv):[A-Za-z0-9._-]{1,80})$/;
const DEFAULT_UI_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".map": "application/json",
};
const MAX_EVIDENCE = 40;

/**
 * What the server may DO besides reading the ledger. Injected: the server itself holds no path to the
 * executor or the workspace (U1). Every call is made as the fixed human `ui:operator` actor.
 */
export interface ApiControl {
  manager: WorkflowManager;
  chat?: ChatService;
  catalog?: () => unknown;
  config?: () => unknown;
  /** Runs one configured agent on a bounded disposable copy (plan 14 Q3.4). */
  trialAgent?: (profileId: string, input: AgentTrialInput) => Promise<AgentTrialResult>;
  /** The operator library (plan 14 Q2.6). Absent ⇒ /api/library answers NOT_FOUND. */
  library?: LibraryStore;
  /** What the operator's file allows library documents (plan 15): the configuration this process loaded at start. Absent ⇒ nothing. */
  libraryPolicy?: () => LibraryPolicy;
  /** Validated provider and role changes, written to the operator file and applied in place (plan 17 P17.8). */
  configWrite?: (change: ConfigChange) => void;
  /** MCP discovery is an operator-only probe: it lists allowlisted tools and never calls them (plan 19 P19.5). */
  mcpServers?: () => readonly McpServerRegistration[];
  mcpDiscover?: (serverId: string, profileId: string) => Promise<McpServerDiscovery>;
}

import { type ConfigChange, ConfigWriteError } from "../config/write.ts";


export interface ApiOptions {
  /** Workflows, chat, catalog and config. Without it the server is read-only plus approvals. */
  control?: ApiControl;
  stateDir: string;
  /** Token required by POST. Generated when omitted. */
  token?: string;
  /** operator: the page gets the session cookie at once. adversarial: only after the one-time code printed by serve (plan 15 D1, D7). */
  trustMode?: "operator" | "adversarial";
  /** Open journals the caller already holds (e.g. a demo that runs the mission in-process). */
  journals?: Map<string, Journal>;
  /** Poll period of the SSE stream, ms. */
  ssePollMs?: number;
  /** Directory of the built web app (default: web/dist). */
  uiDir?: string;
}

export interface ApiServer {
  server: Server;
  token: string;
  /** The one-time code of adversarial mode while it is unused; null otherwise. */
  readonly sessionCode: string | null;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** A request without Origin is an authenticated non-browser client; browser origins must match scheme and authority. */
const sameOrigin = (req: IncomingMessage): boolean => {
  const origin = req.headers["origin"];
  if (!origin) return true;
  try {
    const host = req.headers["host"];
    if (!host) return false;
    const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:";
    const expected = new URL(`${protocol}//${host}`).origin;
    const supplied = new URL(origin);
    return supplied.origin === origin && supplied.origin === expected;
  } catch {
    return false;
  }
};

export function createApi(opts: ApiOptions): ApiServer {
  const token = opts.token ?? randomBytes(16).toString("hex");
  // plan 15 D1 and D7: the session token travels in an HttpOnly cookie, never in a JSON body. In adversarial mode the
  // cookie is handed out only after a one-time code, printed by serve in the terminal, has been redeemed.
  const trustMode = opts.trustMode ?? "operator";
  let pendingCode: string | null = trustMode === "adversarial" ? randomBytes(6).toString("base64url").slice(0, 8) : null;
  let codeFailures = 0;
  const sessionCookie = (): string => `synapser_session=${token}; Path=/; HttpOnly; SameSite=Strict`;
  const own = new Map<string, Journal>();
  const stateDir = resolve(opts.stateDir);
  const uiDir = resolve(opts.uiDir ?? DEFAULT_UI_DIR) + sep;

  const journalFor = (id: string): Journal | null => {
    const held = opts.journals?.get(id);
    if (held) return held;
    const cached = own.get(id);
    if (cached) return cached;
    // never create: an unknown id must not materialise a directory
    if (!RUN_ID.test(id) || !existsSync(join(stateDir, id, "journal.db"))) return null;
    const j = Journal.open(stateDir, id);
    own.set(id, j);
    return j;
  };

  /** seq numbers of the events that concern each id: the citations behind a figure (U2). */
  const evidenceIndex = (j: Journal) => {
    const byId = new Map<string, number[]>();
    const add = (k: string, seq: number) => {
      const a = byId.get(k) ?? [];
      a.push(seq);
      byId.set(k, a);
    };
    const taskOfAction = new Map<string, string>();
    for (const e of j.listEvents()) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      add(e.entityId, e.seq);
      if (typeof d["task_id"] === "string") add(d["task_id"] as string, e.seq);
      if (e.entity === "action" && e.toState === "PREPARED") taskOfAction.set(e.entityId, String(d["task_id"]));
      if (e.entity === "action" && taskOfAction.has(e.entityId)) add(taskOfAction.get(e.entityId) as string, e.seq);
      if (e.entity === "task") add(e.entityId, e.seq);
      if (e.entity === "dispatch" || e.entity === "delegation" || e.entity === "approval" || e.entity === "alert" || e.entity === "intent") add(e.entityId, e.seq);
    }
    return {
      of: (ids: readonly string[]): { seqs: number[]; total: number } => {
        const set = new Set<number>();
        for (const id of ids) for (const s of byId.get(id) ?? []) set.add(s);
        const all = [...set].sort((a, b) => a - b);
        return { seqs: all.slice(-MAX_EVIDENCE), total: all.length };
      },
    };
  };

  const listRuns = () => {
    const ids = new Set<string>(opts.journals?.keys() ?? []);
    if (existsSync(stateDir)) {
      for (const n of readdirSync(stateDir)) {
        try {
          if (RUN_ID.test(n) && !n.startsWith("_") && statSync(join(stateDir, n)).isDirectory() && existsSync(join(stateDir, n, "journal.db"))) ids.add(n);
        } catch {
          /* ignore */
        }
      }
    }
    return [...ids].sort().map((id) => {
      const j = journalFor(id)!;
      const v = verify(j);
      const s = swarmState(j);
      return { id, state: s.mission.state, events: v.events, head: v.head, chainOk: v.ok, tasks: s.agents.length, pendingApprovals: s.pendingApprovals.length };
    });
  };

  /** The ONE write guard: same origin, then the session token. Answers the refusal and returns false when refused. */
  // a header (tools and tests) or the session cookie (the page); every comparison runs in constant time
  const sameSecret = (given: string | undefined, secret: string): boolean => {
    if (given === undefined) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [key, ...value] = part.trim().split("=");
      if (key === name) return value.join("=");
    }
    return undefined;
  };
  const tokenOk = (req: IncomingMessage): boolean => {
    const header = req.headers["x-synapser-token"];
    return sameSecret(typeof header === "string" ? header : undefined, token) || sameSecret(cookieOf(req, "synapser_session"), token);
  };
  const writeAllowed = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!sameOrigin(req)) {
      fail(res, 403, "CROSS_ORIGIN");
      return false;
    }
    if (!tokenOk(req)) {
      fail(res, 401, "BAD_TOKEN");
      return false;
    }
    return true;
  };

  /** Workflows, chat, catalog, config. Writes need the session token and same origin; the actor is fixed. */
  async function control(c: ApiControl, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    const parts = path.split("/").filter(Boolean).slice(1); // after "api"
    const [top, id, action] = parts as [string, string | undefined, string | undefined];
    if (method !== "GET" && !writeAllowed(req, res)) return;
    // plan 17 P17.8: PUT /api/config/providers/<id> and PUT /api/config/roles/<role>. Checked before the id rules below.
    if (top === "config" && (id === "providers" || id === "roles" || id === "agents") && method === "PUT" && action !== undefined && c.configWrite) {
      const body = await readBody(req, res);
      if (body === undefined) return;
      try {
        c.configWrite({ kind: id, id: action, value: body } as ConfigChange);
        return json(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof ConfigWriteError) return json(res, 400, { error: "INVALID_CONFIG", errors: e.errors });
        throw e;
      }
    }
    if (top === "mcp" && id && action === "discover" && method === "POST") {
      if (!c.mcpDiscover) return fail(res, 404, "MCP_DISCOVERY_UNAVAILABLE");
      const body = await readBody(req, res) as { profileId?: unknown } | undefined;
      if (body === undefined) return;
      if (typeof body.profileId !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(body.profileId)) return fail(res, 400, "INVALID_PROFILE_ID");
      const registration = c.mcpServers?.().find((server) => server.id === id);
      if (!registration) return fail(res, 404, "UNKNOWN_MCP_SERVER");
      if (!registration.enabled) return fail(res, 409, "MCP_SERVER_DISABLED");
      if (!Object.hasOwn(registration.profiles, body.profileId)) return fail(res, 403, "MCP_PROFILE_NOT_CONFIGURED");
      try {
        return json(res, 200, await c.mcpDiscover(id, body.profileId));
      } catch (error) {
        return fail(res, 502, "MCP_DISCOVERY_FAILED", String((error as Error).message ?? error).slice(0, 300));
      }
    }
    const asResult = <T>(r: { ok: true } & T | { ok: false; code: string; errors?: string[] }) =>
      r.ok ? json(res, 200, r) : json(res, 409, { error: (r as { code: string }).code, errors: (r as { errors?: string[] }).errors ?? [] });
    if (id !== undefined && !RUN_ID.test(id)) return fail(res, 400, "BAD_ID");
    const m = c.manager;
    if (top === "catalog" && method === "GET") return json(res, 200, { agents: c.catalog?.() ?? [] });
    if (top === "agents" && id && action === "trial" && method === "POST") {
      if (!c.trialAgent) return fail(res, 404, "TRIAL_UNAVAILABLE");
      const body = await readBody(req, res);
      if (body === undefined) return;
      const input = body as Partial<AgentTrialInput>;
      if (typeof input.task !== "string" || !Number.isInteger(input.timeLimitSeconds) || (input.maxBudgetUsd !== undefined && typeof input.maxBudgetUsd !== "number")) return fail(res, 400, "INVALID_TRIAL_INPUT");
      try {
        return json(res, 200, await c.trialAgent(id, input as AgentTrialInput));
      } catch (error) {
        return fail(res, 400, "TRIAL_REFUSED", String((error as Error).message ?? error).slice(0, 400));
      }
    }
    if (top === "config" && method === "GET") return json(res, 200, c.config?.() ?? {});
    // the designer's live check: the same validator as create, nothing is written (plan 14 Q3.1)
    if (top === "designer" && id === "check" && method === "POST") {
      const b = await readBody(req, res);
      return b === undefined ? undefined : json(res, 200, m.check(b));
    }
    // the operator's first screen (plan 14 Q4.1): what is active, what waits for a person, what it costs. An unknown
    // price is counted apart, never summed as zero.
    if (top === "home" && method === "GET") {
      const workflows = m.list();
      const runs = listRuns();
      // the same figures the Cost view shows, summed over the runs: agent runs (per profile, so each run counts once)
      // and the planner's calls. Chat and advisor calls are in neither, so they are not here either.
      let knownUsd = 0;
      let unknownRuns = 0;
      let agentRuns = 0;
      for (const { id } of runs) {
        const j = journalFor(id);
        if (!j) continue;
        for (const row of costBy(j, "profile")) {
          knownUsd += row.usd;
          unknownRuns += row.usdUnknownRuns;
          agentRuns += row.runs;
        }
        const orch = orchestrationCost(j);
        if (orch.usd !== null) knownUsd += orch.usd;
        else if (orch.calls > 0) unknownRuns += 1;
      }
      const profiles = ((c.config?.() ?? {}) as { profiles?: { enabled: boolean }[] }).profiles ?? [];
      return json(res, 200, {
        workflows: {
          total: workflows.length,
          active: workflows.filter((w) => !["DONE", "FAILED", "CANCELLED"].includes(w.state)).map((w) => ({ id: w.id, title: w.workflow.title, state: w.state, revision: w.revision })),
        },
        pendingApprovals: runs.reduce((n, r) => n + r.pendingApprovals, 0),
        runsWaiting: runs.filter((r) => r.pendingApprovals > 0).map((r) => r.id),
        agents: { total: profiles.length, enabled: profiles.filter((p) => p.enabled).length },
        cost: { knownUsd: Math.round(knownUsd * 1e6) / 1e6, unknownRuns, agentRuns },
        runs: runs.length,
      });
    }
    if (top === "library" && c.library) return libraryRoute(c.library, req, res, parts.slice(1), method, withLibraryProviders(c.libraryPolicy?.() ?? NO_LIBRARY_POLICY, c.library), (agentId) => reviewingWorkflows(c.manager, agentId));
    if (top === "workflows") {
      if (!id && method === "GET") return json(res, 200, { workflows: m.list().map((v) => ({ id: v.id, title: v.workflow.title, state: v.state, revision: v.revision, reason: v.reason })) });
      if (!id && method === "POST") {
        const b = await readBody(req, res);
        return b === undefined ? undefined : asResult(m.create(b, OPERATOR));
      }
      if (id && !action && method === "GET") {
        const v = m.status(id);
        return v ? json(res, 200, v) : fail(res, 404, "UNKNOWN_WORKFLOW");
      }
      if (id && !action && method === "PUT") {
        const b = await readBody(req, res);
        return b === undefined ? undefined : asResult(m.edit(id, b, OPERATOR));
      }
      if (id && action === "start" && method === "POST") return asResult(m.start(id, OPERATOR));
      if (id && action === "cancel" && method === "POST") return asResult(m.cancel(id, OPERATOR));
      // what the advisor proposed and what effects were requested, read-only (plan 14 Q4.4): the CLI and MCP already had them
      if (id && action === "interventions" && method === "GET") {
        const adv = m.advisorOf(id);
        if (!adv) return m.status(id) ? json(res, 200, { advisor: false, interventions: [] }) : fail(res, 404, "UNKNOWN_WORKFLOW");
        return json(res, 200, { advisor: true, interventions: adv.list().map((r) => ({ id: r.id, type: r.type, task: r.task, state: r.state, trigger: r.trigger, reason: r.reason })) });
      }
      if (id && action === "effects" && method === "GET") {
        const b = m.effects(id);
        return b ? json(res, 200, { effects: b.records().map((r) => ({ id: r.id, kind: r.kind, state: r.state, summary: r.summary, rule: r.rule, evidence: r.evidence })) }) : fail(res, 404, "UNKNOWN_WORKFLOW");
      }
    }
    if (top === "chat" && c.chat) {
      if (!id && method === "GET") return json(res, 200, { conversations: c.chat.conversations() });
      if (id === "send" && method === "POST") {
        const b = (await readBody(req, res)) as { conversationId?: string; text?: string } | undefined;
        if (b === undefined) return;
        if (!b.text || typeof b.text !== "string") return fail(res, 400, "TEXT_REQUIRED");
        try {
          return json(res, 200, await c.chat.send(b.conversationId ?? null, b.text, OPERATOR));
        } catch (e) {
          return fail(res, 502, "CHAT_FAILED", String((e as Error).message ?? e).slice(0, 200));
        }
      }
      if (id && method === "GET") return json(res, 200, { messages: c.chat.history(id) });
    }
    return fail(res, method === "GET" || method === "POST" || method === "PUT" ? 404 : 405, method === "GET" || method === "POST" || method === "PUT" ? "NOT_FOUND" : "METHOD_NOT_ALLOWED");
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---- static UI ----
    if (method === "GET" && !path.startsWith("/api/")) {
      if (!existsSync(join(uiDir, "index.html"))) {
        return fail(res, 503, "UI_NOT_BUILT", "run `npm --prefix web install && npm --prefix web run build`");
      }
      const rel = path === "/" ? "index.html" : path.slice(1);
      const abs = normalize(join(uiDir, rel));
      // a single-page app: unknown paths without an extension fall back to the shell
      const fallback = !abs.startsWith(uiDir) ? null : !existsSync(abs) && !/\.[a-z0-9]+$/i.test(rel) ? join(uiDir, "index.html") : abs;
      if (!fallback || !existsSync(fallback) || !statSync(fallback).isFile()) return fail(res, 404, "NOT_FOUND");
      const file = fallback;
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // no inline script, no third-party origin: the page can only talk to its own server
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
      });
      return void res.end(readFileSync(file));
    }

    if (opts.control && /^\/api\/(workflows|chat|catalog|config|library|designer|home|agents|mcp)(\/|$)/.test(path)) return control(opts.control, req, res, path, method);

    const m = /^\/api\/(session|runs)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(path);
    if (!m) return fail(res, 404, "NOT_FOUND");
    const [, top, runId, what, sub] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];

    if (top === "session" && method === "GET") {
      // the page learns whether it has the cookie and whether a code is needed; the token itself never leaves the cookie
      if (trustMode === "operator" || tokenOk(req)) {
        res.setHeader("set-cookie", sessionCookie());
        return json(res, 200, { ok: true, mode: trustMode });
      }
      return json(res, 200, { ok: false, mode: trustMode, needsCode: true });
    }
    if (top === "session" && runId === "redeem" && method === "POST") {
      if (trustMode !== "adversarial") return fail(res, 404, "NOT_FOUND");
      if (!sameOrigin(req)) return fail(res, 403, "CROSS_ORIGIN");
      const body = await readBody(req, res);
      if (body === undefined) return;
      if (codeFailures >= 5) return fail(res, 429, "TOO_MANY_ATTEMPTS");
      const given = (body as { code?: unknown }).code;
      if (pendingCode === null || typeof given !== "string" || !sameSecret(given, pendingCode)) {
        codeFailures++;
        return fail(res, 401, "BAD_CODE");
      }
      pendingCode = null; // one use: a second redemption finds no code
      res.setHeader("set-cookie", sessionCookie());
      return json(res, 200, { ok: true, mode: trustMode });
    }
    if (top === "runs" && !runId && method === "GET") return json(res, 200, { runs: listRuns() });
    if (!runId) return fail(res, 404, "NOT_FOUND");
    if (!RUN_ID.test(runId)) return fail(res, 400, "BAD_RUN_ID");
    const j = journalFor(runId);
    if (!j) return fail(res, 404, "UNKNOWN_RUN");

    if (method === "POST") {
      if (what !== "approvals" || !sub) return fail(res, 404, "NOT_FOUND");
      // same-origin only: a cross-site page can neither read the token nor pass this check
      if (!writeAllowed(req, res)) return;
      let approvalKey: string;
      try {
        approvalKey = decodeURIComponent(sub);
      } catch {
        return fail(res, 400, "BAD_TASK_ID");
      }
      if (!APPROVAL_KEY.test(approvalKey)) return fail(res, 400, "BAD_TASK_ID");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 10_000) return fail(res, 413, "TOO_LARGE");
      }
      let b: { decision?: string; actor?: string; planDigest?: string; reason?: string };
      try {
        b = JSON.parse(body) as typeof b;
      } catch {
        return fail(res, 400, "BAD_JSON");
      }
      if (b.decision !== "APPROVED" && b.decision !== "REJECTED") return fail(res, 400, "BAD_DECISION");
      const actor = String(b.actor ?? "").trim().slice(0, 80) || "ui:anonymous";
      const r = decideApproval(j, runId, {
        taskId: approvalKey,
        planDigest: String(b.planDigest ?? ""),
        // plan steps are bound to the plan digest; start/conditions/effects to their own
        currentDigest: isSelfBound(approvalKey) ? (pendingGates(j).find((g) => g.key === approvalKey)?.digest ?? "") : currentPlanDigest(j),
        decision: b.decision,
        actor,
        ...(b.reason ? { reason: String(b.reason).slice(0, 300) } : {}),
      });
      return r.ok ? json(res, 200, { ok: true }) : fail(res, 409, r.code);
    }
    if (method !== "GET") return fail(res, 405, "METHOD_NOT_ALLOWED");

    switch (what) {
      case "challenge": {
        // HUMAN channel only: the code an operator may hand to an agent so it can relay an approval by MCP
        if (!tokenOk(req)) return fail(res, 401, "BAD_TOKEN");
        const key = url.searchParams.get("key") ?? "";
        const digest = currentPlanDigest(j);
        const code = readChallenge(j, key, url.searchParams.get("digest") ?? digest);
        return code ? json(res, 200, { key, code }) : fail(res, 404, "NO_CHALLENGE");
      }
      case "state": {
        const atSeq = url.searchParams.get("seq");
        const st = swarmState(j, atSeq ? Number(atSeq) : undefined);
        const ev = evidenceIndex(j);
        return json(res, 200, {
          ...st,
          planDigest: currentPlanDigest(j),
          agents: st.agents.map((a) => ({ ...a, evidence: ev.of([a.taskId]) })),
          pendingApprovals: pendingGates(j).map((g) => g.key),
          gates: pendingGates(j).map((g) => ({ key: g.key, kind: g.kind, digest: g.digest, summary: g.why, seq: g.seq })),
          stepApprovals: pendingApprovals(j, currentPlanDigest(j)),
        });
      }
      case "timeline":
        return json(res, 200, { entries: timeline(j, { ...(url.searchParams.get("task") ? { taskId: url.searchParams.get("task") as string } : {}), ...(url.searchParams.get("since") ? { sinceSeq: Number(url.searchParams.get("since")) } : {}) }) });
      case "cost": {
        const by = (url.searchParams.get("by") ?? "profile") as "profile" | "task" | "adapter" | "model" | "role";
        const runs = j.listAgentRuns();
        const ev = evidenceIndex(j);
        const rows = costBy(j, by).map((r) => {
          const ids = runs
            .filter((x) => (by === "profile" ? x.profileId === r.key : by === "task" ? (x.taskId ?? "(none)") === r.key : by === "adapter" ? x.adapter === r.key : by === "role" ? x.role === r.key : x.models.includes(r.key) || (x.models.length === 0 && r.key === "(unknown)")))
            .map((x) => x.agentRunId);
          return { ...r, evidence: ev.of(ids) };
        });
        return json(res, 200, { by, rows, orchestration: orchestrationCost(j) });
      }
      case "waste": {
        const w = waste(j);
        const ev = evidenceIndex(j);
        return json(res, 200, { ...w, wastedRuns: w.wastedRuns.map((r) => ({ ...r, evidence: ev.of([r.id]) })) });
      }
      case "coordination": {
        const ev = evidenceIndex(j);
        return json(res, 200, { rows: coordination(j).map((r) => ({ ...r, evidence: ev.of([r.taskId]) })) });
      }
      case "verify":
        return json(res, 200, verify(j, url.searchParams.get("head") ?? undefined));
      case "export":
        return json(res, 200, exportLedger(j));
      case "who-changed":
        return json(res, 200, { path: url.searchParams.get("path") ?? "", changes: whoChanged(j, url.searchParams.get("path") ?? "") });
      case "why": {
        const a = url.searchParams.get("action") ?? "";
        if (!a) return fail(res, 400, "ACTION_REQUIRED");
        return json(res, 200, why(j, a));
      }
      case "files": {
        const paths = new Set<string>();
        for (const a of j.listAllActions()) for (const f of j.getActionFiles(a.actionId)) paths.add(f.path);
        return json(res, 200, { files: [...paths].sort() });
      }
      case "actions":
        return json(res, 200, {
          actions: j.listAllActions().map((a) => ({ actionId: a.actionId, taskId: a.taskId, state: a.state, files: j.getActionFiles(a.actionId).map((f) => f.path).sort() })),
        });
      case "events":
        return stream(req, res, j, Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0) || 0);
      default:
        return fail(res, 404, "NOT_FOUND");
    }
  }

  function stream(req: IncomingMessage, res: ServerResponse, j: Journal, since: number): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
    res.write("retry: 1000\n\n");
    let last = since;
    const send = (): void => {
      for (const e of timeline(j, { sinceSeq: last })) {
        res.write(`id: ${e.seq}\nevent: ledger\ndata: ${JSON.stringify(e)}\n\n`);
        last = e.seq;
      }
    };
    send();
    const poll = setInterval(send, opts.ssePollMs ?? 250);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(beat);
    });
  }

  const server = createServer((req, res) => {
    // P15 IC4: a page that rebinds its name to 127.0.0.1 reaches this server under its own host name, and the origin
    // check cannot see the difference. The Host header must name this very server.
    const port = (server.address() as { port: number } | null)?.port;
    const host = req.headers["host"];
    if (port === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return fail(res, 421, "MISDIRECTED_HOST");
    route(req, res).catch((e) => {
      if (!res.headersSent) fail(res, 500, "INTERNAL", String((e as Error).message ?? e).slice(0, 200));
      else res.end();
    });
  });
  return {
    server,
    token,
    get sessionCode() {
      return pendingCode;
    },
    listen: (port = 0, host = "127.0.0.1") =>
      new Promise((ok, bad) => {
        server.once("error", bad);
        server.listen(port, host, () => ok((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => {
          for (const j of own.values()) j.close();
          ok();
        });
      }),
  };
}
