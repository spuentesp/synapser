// Read-mostly HTTP API over the ledger (plan 12). It imports the journal, the audit queries and the
// approval gate — NOT the executor: nothing here can touch the workspace (U1). The single write is an
// approval decision, an event on the ledger bound to the current plan digest (U4).
//
//   GET  /api/session                      { token }          same-origin only (no CORS headers)
//   GET  /api/runs                         runs found under the state dir
//   GET  /api/runs/:id/state[?seq=N]       swarm state (replayable at any seq)
//   GET  /api/runs/:id/{timeline,cost,waste,coordination,verify,export}
//   GET  /api/runs/:id/why?action=ID       declared chain + the agent's own words (labelled)
//   GET  /api/runs/:id/events?since=SEQ    Server-Sent Events: the ledger as it grows
//   POST /api/runs/:id/approvals/:task     { decision, actor, planDigest }  header x-synapser-token

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coordination, costBy, exportLedger, orchestrationCost, timeline, verify, waste, whoChanged, why } from "../audit/queries.ts";
import { swarmState } from "../audit/state.ts";
import { Journal } from "../journal/journal.ts";
import { currentPlanDigest, decideApproval, pendingApprovals, readChallenge } from "../orchestration/gates.ts";

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,80}$/;
const DEFAULT_UI_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".map": "application/json",
};
const MAX_EVIDENCE = 40;

export interface ApiOptions {
  stateDir: string;
  /** Token required by POST. Generated when omitted. */
  token?: string;
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
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
};
const fail = (res: ServerResponse, status: number, code: string, detail?: string): void => json(res, status, { error: code, ...(detail ? { detail } : {}) });

export function createApi(opts: ApiOptions): ApiServer {
  const token = opts.token ?? randomBytes(16).toString("hex");
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

    const m = /^\/api\/(session|runs)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(path);
    if (!m) return fail(res, 404, "NOT_FOUND");
    const [, top, runId, what, sub] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];

    if (top === "session" && method === "GET") return json(res, 200, { token });
    if (top === "runs" && !runId && method === "GET") return json(res, 200, { runs: listRuns() });
    if (!runId) return fail(res, 404, "NOT_FOUND");
    if (!RUN_ID.test(runId)) return fail(res, 400, "BAD_RUN_ID");
    const j = journalFor(runId);
    if (!j) return fail(res, 404, "UNKNOWN_RUN");

    if (method === "POST") {
      if (what !== "approvals" || !sub) return fail(res, 404, "NOT_FOUND");
      // same-origin only: a cross-site page can neither read the token nor pass this check
      const origin = req.headers["origin"];
      if (origin && new URL(origin).host !== req.headers["host"]) return fail(res, 403, "CROSS_ORIGIN");
      if (req.headers["x-synapser-token"] !== token) return fail(res, 401, "BAD_TOKEN");
      if (!TASK_ID.test(sub)) return fail(res, 400, "BAD_TASK_ID");
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
        taskId: sub,
        planDigest: String(b.planDigest ?? ""),
        currentDigest: currentPlanDigest(j),
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
        if (req.headers["x-synapser-token"] !== token) return fail(res, 401, "BAD_TOKEN");
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
          pendingApprovals: pendingApprovals(j, currentPlanDigest(j)),
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
    route(req, res).catch((e) => {
      if (!res.headersSent) fail(res, 500, "INTERNAL", String((e as Error).message ?? e).slice(0, 200));
      else res.end();
    });
  });
  return {
    server,
    token,
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
