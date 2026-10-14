// Synapser observation UI. No framework, no dependencies. Every number shown is a query over the
// ledger and cites the events behind it (plan 12, U2). All dynamic text is escaped.

const T = {
  es: {
    run: "Corrida", swarm: "Enjambre", timeline: "Línea de tiempo", why: "Por qué", cost: "Costo", coordination: "Coordinación",
    approvals: "Aprobaciones", integrity: "Integridad", live: "En vivo", replay: "Reproducción", noRuns: "No hay corridas en este directorio de estado.",
    verified: "Cadena verificada", broken: "Cadena rota", events: "eventos", head: "cabeza", tasks: "tareas",
    waitingOn: "espera a", holds: "retiene", observed: "observado en Zoanthrope", steps: "pasos", searches: "búsquedas",
    unknownCost: "sin precio", evidence: "evidencia", seq: "seq", time: "hora", kind: "tipo", summary: "resumen",
    pickAction: "Elige una acción para ver por qué cambió", chain: "Cadena declarada", asserted: "Lo que el agente afirmó (no es evidencia)",
    mission: "Misión", task: "Tarea", runs: "Corridas de agente", action: "Acción", files: "Archivos", validations: "Validaciones",
    linkedBy: "atribución", approve: "Aprobar", reject: "Rechazar", actor: "Tu nombre", noApprovals: "No hay compuertas pendientes.",
    staleDigest: "El plan cambió: esta aprobación ya no vale. Actualiza.", decided: "Registrado en el ledger",
    wastedRuns: "Corridas desperdiciadas", total: "total", byProfile: "por perfil", byTask: "por tarea", byModel: "por modelo",
    waits: "esperas", waitMs: "tiempo de espera", stale: "vistas rancias", recoveries: "recuperaciones", actions: "acciones",
    verifyNow: "Verificar de nuevo", download: "Descargar exportación", howVerify: "Verificación fuera de línea",
    gaps: "huecos declarados", alerts: "alertas", delegations: "delegaciones", filter: "filtrar", all: "todos", close: "Cerrar",
    cached: "memoria", usd: "USD", tokens: "tokens", why_unknownCost: "Costo desconocido: nunca se suma como 0",
  },
  en: {
    run: "Run", swarm: "Swarm", timeline: "Timeline", why: "Why", cost: "Cost", coordination: "Coordination",
    approvals: "Approvals", integrity: "Integrity", live: "Live", replay: "Replay", noRuns: "No runs in this state directory.",
    verified: "Chain verified", broken: "Chain broken", events: "events", head: "head", tasks: "tasks",
    waitingOn: "waiting on", holds: "holds", observed: "observed in Zoanthrope", steps: "steps", searches: "searches",
    unknownCost: "no price", evidence: "evidence", seq: "seq", time: "time", kind: "kind", summary: "summary",
    pickAction: "Pick an action to see why it changed", chain: "Declared chain", asserted: "What the agent asserted (not evidence)",
    mission: "Mission", task: "Task", runs: "Agent runs", action: "Action", files: "Files", validations: "Validations",
    linkedBy: "attribution", approve: "Approve", reject: "Reject", actor: "Your name", noApprovals: "No pending gates.",
    staleDigest: "The plan changed: this approval no longer applies. Refresh.", decided: "Recorded on the ledger",
    wastedRuns: "Wasted runs", total: "total", byProfile: "by profile", byTask: "by task", byModel: "by model",
    waits: "waits", waitMs: "wait time", stale: "stale views", recoveries: "recoveries", actions: "actions",
    verifyNow: "Verify again", download: "Download export", howVerify: "Offline verification",
    gaps: "declared gaps", alerts: "alerts", delegations: "delegations", filter: "filter", all: "all", close: "Close",
    cached: "cached", usd: "USD", tokens: "tokens", why_unknownCost: "Unknown cost is never summed as 0",
  },
};
const ST = {
  es: { planned: "planificada", waiting_approval: "espera aprobación", ready: "lista", running: "ejecutando", waiting: "esperando", validating: "validando", done: "hecha", failed: "falló", cancelled: "cancelada" },
  en: { planned: "planned", waiting_approval: "awaiting approval", ready: "ready", running: "running", waiting: "waiting", validating: "validating", done: "done", failed: "failed", cancelled: "cancelled" },
};

const S = {
  lang: (localStorage.getItem("lang") || (navigator.language || "es").slice(0, 2)) === "en" ? "en" : "es",
  theme: localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"),
  view: "swarm", runs: [], runId: null, state: null, head: 0, seq: null, live: true, token: null,
  timeline: null, cache: {}, es: null, refreshTimer: null, whyAction: null, costBy: "profile", filter: "", kindFilter: "",
};
const VIEWS = ["swarm", "timeline", "why", "cost", "coordination", "approvals", "integrity"];
{
  const h = decodeURIComponent(location.hash.slice(1)).split("?")[0];
  if (VIEWS.includes(h)) S.view = h;
  const q = new URLSearchParams(location.search);
  if (q.get("lang") === "en" || q.get("lang") === "es") S.lang = q.get("lang");
  if (q.get("theme") === "light" || q.get("theme") === "dark") S.theme = q.get("theme");
}
const t = (k) => T[S.lang][k] ?? k;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h, n = 12) => (h ? esc(String(h).replace("sha256:", "").slice(0, n)) : "—");
const fmtUsd = (n) => (n == null ? "?" : `$${n.toFixed(n < 0.1 ? 4 : 2)}`);
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(S.lang, { hour12: false });
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status, body });
  return body;
}
const runPath = (p) => `/api/runs/${encodeURIComponent(S.runId)}${p}`;

// ---------- data ----------
async function loadRuns() {
  S.runs = (await api("/api/runs")).runs;
  if (!S.runId || !S.runs.some((r) => r.id === S.runId)) S.runId = S.runs.at(-1)?.id ?? null;
}
async function loadState() {
  if (!S.runId) return;
  S.state = await api(runPath(`/state${S.seq ? `?seq=${S.seq}` : ""}`));
  const run = S.runs.find((r) => r.id === S.runId);
  S.head = run?.events ?? S.state.atSeq;
}
async function loadView() {
  if (!S.runId) return;
  const need = {
    timeline: async () => (S.timeline = (await api(runPath("/timeline"))).entries),
    cost: async () => (S.cache.cost = await api(runPath(`/cost?by=${S.costBy}`))),
    coordination: async () => (S.cache.coord = await api(runPath("/coordination"))),
    why: async () => {
      S.cache.actions = (await api(runPath("/actions"))).actions;
      // open on something useful: the most recent change that actually landed
      if (!S.whyAction) S.whyAction = [...S.cache.actions].reverse().find((a) => a.files.length && ["SETTLED", "APPLIED"].includes(a.state))?.actionId ?? null;
      if (S.whyAction) S.cache.why = await api(runPath(`/why?action=${encodeURIComponent(S.whyAction)}`));
    },
    integrity: async () => (S.cache.verify = await api(runPath("/verify"))),
  }[S.view];
  if (need) await need();
  if (S.view === "cost") S.cache.waste = await api(runPath("/waste"));
}
async function refresh() {
  await loadRuns();
  await loadState();
  await loadView();
  render();
}
function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => S.live && refresh().catch(() => {}), 150);
}
function connect() {
  if (S.es) S.es.close();
  if (!S.runId) return;
  S.es = new EventSource(runPath(`/events?since=${S.head || 0}`));
  S.es.addEventListener("ledger", (e) => {
    const ev = JSON.parse(e.data);
    S.head = Math.max(S.head, ev.seq);
    scheduleRefresh();
  });
}

// ---------- render ----------
function render() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-t]").forEach((n) => (n.textContent = t(n.dataset.t)));
  $("#langBtn").textContent = S.lang.toUpperCase();
  $("#themeBtn").textContent = S.theme === "dark" ? "☾" : "☀";
  const sel = $("#runSel");
  sel.innerHTML = S.runs.map((r) => `<option value="${esc(r.id)}" ${r.id === S.runId ? "selected" : ""}>${esc(r.id)}</option>`).join("");
  const run = S.runs.find((r) => r.id === S.runId);
  const ib = $("#integrity");
  if (run) {
    ib.className = `integrity ${run.chainOk ? "ok" : "bad"}`;
    ib.innerHTML = `<div class="big">${run.chainOk ? "✓" : "✗"} ${t(run.chainOk ? "verified" : "broken")}</div><div class="muted">${run.events} ${t("events")}</div><div class="mono muted">${t("head")} ${short(run.head, 14)}</div>`;
  } else ib.innerHTML = "";
  const pend = S.state?.pendingApprovals?.length ?? 0;
  const nav = [["swarm", t("swarm")], ["timeline", t("timeline")], ["why", t("why")], ["cost", t("cost")], ["coordination", t("coordination")], ["approvals", t("approvals"), pend], ["integrity", t("integrity")]];
  $("#nav").innerHTML = nav.map(([id, label, n]) => `<button data-view="${id}" ${S.view === id ? 'aria-current="page"' : ""}><span>${esc(label)}</span>${n ? `<span class="count">${n}</span>` : ""}</button>`).join("");
  const m = S.state?.mission;
  $("#missionLine").innerHTML = m ? `${esc(m.state ?? "—")} <span class="muted">· plan r${m.planRevision} · ${S.state.agents.length} ${t("tasks")}</span>` : "";
  const range = $("#seqRange");
  range.max = String(Math.max(1, S.head));
  range.value = String(S.seq ?? S.head);
  $("#seqLabel").textContent = S.seq ? `${t("replay")} · ${t("seq")} ${S.seq}/${S.head}` : `${t("seq")} ${S.head}`;
  const lb = $("#liveBtn");
  lb.textContent = t("live");
  lb.className = `pill live ${S.live && !S.seq ? "on" : ""}`;
  const view = $("#view");
  if (!run) {
    view.innerHTML = `<div class="empty">${t("noRuns")}</div>`;
    return;
  }
  view.innerHTML = { swarm: vSwarm, timeline: vTimeline, why: vWhy, cost: vCost, coordination: vCoord, approvals: vApprovals, integrity: vIntegrity }[S.view]();
  if (S.view === "swarm") drawEdges();
}

const cite = (ev) => (ev && ev.total ? `<button class="cite" data-cite="${ev.seqs.join(",")}">${t("evidence")} ·${ev.total}</button>` : "");

function vSwarm() {
  const A = S.state.agents.filter((a) => !(a.taskId === "validate" && a.steps === 0 && a.status === "planned" && S.state.agents.length > 1 && false));
  if (!A.length) return `<div class="empty">—</div>`;
  const by = new Map(A.map((a) => [a.taskId, a]));
  const lvl = new Map();
  const level = (id, seen = new Set()) => {
    if (lvl.has(id)) return lvl.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const a = by.get(id);
    const l = a && a.deps.length ? 1 + Math.max(...a.deps.filter((d) => by.has(d)).map((d) => level(d, seen)), -1) : 0;
    lvl.set(id, l);
    return l;
  };
  A.forEach((a) => level(a.taskId));
  const cols = Math.max(...lvl.values()) + 1;
  const columns = Array.from({ length: cols }, () => []);
  A.forEach((a) => columns[lvl.get(a.taskId)].push(a));
  const card = (a) => {
    const usd = a.runs.usd || a.modelCalls.usd;
    const unknown = a.runs.usdUnknownRuns + a.modelCalls.unpricedCalls;
    const tok = a.runs.inputTokens + a.runs.outputTokens || a.modelCalls.promptTokens + a.modelCalls.completionTokens;
    return `<article class="card s-${esc(a.status)}" data-task="${esc(a.taskId)}">
      <div class="row"><span class="title">${esc(a.taskId)}</span><span class="st ${esc(a.status)}">${esc(ST[S.lang][a.status] ?? a.status)}</span></div>
      <div class="kv">${a.profile ? `<span><b>${esc(a.profile)}</b></span>` : ""}${a.kind ? `<span>${esc(a.kind)}</span>` : ""}${a.requestedBy ? `<span>↳ ${esc(a.requestedBy)} · d${a.depth}</span>` : ""}</div>
      ${a.waitingOn ? `<div class="wait">⏳ ${t("waitingOn")} <b>${esc(a.waitingOn.holder.split(":").pop())}</b> · <span class="mono">${esc(a.waitingOn.path)}</span></div>` : ""}
      ${a.heldFiles.length ? `<div class="chips"><span class="muted">${t("holds")}</span>${a.heldFiles.map((f) => `<span class="chip held">${esc(f)}</span>`).join("")}</div>` : ""}
      ${a.observedHeld.length ? `<div class="chips"><span class="muted">${t("observed")}</span>${a.observedHeld.map((f) => `<span class="chip obs">${esc(f)}</span>`).join("")}</div>` : ""}
      <div class="kv"><span><b>${a.steps}</b> ${t("steps")}</span>${tok ? `<span><b>${fmtTok(tok)}</b> ${t("tokens")}</span>` : ""}${usd || unknown ? `<span title="${esc(t("why_unknownCost"))}">${usd ? `<b>${fmtUsd(usd)}</b>` : `<b>?</b> ${t("unknownCost")}`}${usd && unknown ? ` + ${unknown}×?` : ""}</span>` : ""}${a.searches ? `<span><b>${a.searches}</b> ${t("searches")}</span>` : ""}</div>
      ${cite(a.evidence)}
    </article>`;
  };
  const extra = [];
  if (S.state.alerts.length) extra.push(`<span class="pill">⚠ ${S.state.alerts.length} ${t("alerts")}</span>`);
  if (S.state.zoo.gaps) extra.push(`<span class="pill">∅ ${S.state.zoo.gaps} ${t("gaps")}</span>`);
  if (S.state.delegations.accepted || S.state.delegations.rejected) extra.push(`<span class="pill">↳ ${S.state.delegations.accepted}/${S.state.delegations.rejected} ${t("delegations")}</span>`);
  return `<h2>${t("swarm")}</h2><div class="toolbar">${extra.join("")}</div>
    <div class="dag" id="dag" style="grid-template-columns: repeat(${cols}, minmax(220px, 1fr))">
      <svg id="edges"></svg>${columns.map((c) => `<div class="col">${c.map(card).join("")}</div>`).join("")}
    </div>`;
}
function drawEdges() {
  const dag = $("#dag");
  const svg = $("#edges");
  if (!dag || !svg) return;
  const box = dag.getBoundingClientRect();
  const pos = (id) => {
    const el = dag.querySelector(`[data-task="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2 };
  };
  const css = getComputedStyle(document.documentElement);
  let d = "";
  for (const a of S.state.agents) {
    const to = pos(a.taskId);
    if (a.taskId === "validate" || a.taskId.startsWith("validate-")) continue; // acceptance waits for everything: implied
    for (const dep of a.deps) {
      const from = pos(dep);
      if (!from || !to) continue;
      const mx = (from.r + to.l) / 2;
      d += `<path d="M${from.r},${from.y} C${mx},${from.y} ${mx},${to.y} ${to.l},${to.y}" fill="none" stroke="${css.getPropertyValue("--line").trim()}" stroke-width="1.6"/>`;
    }
  }
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = d;
}

function vTimeline() {
  const all = S.timeline ?? [];
  const kinds = [...new Set(all.map((e) => e.kind))].sort();
  const q = S.filter.toLowerCase();
  const rows = all.filter((e) => (!S.kindFilter || e.kind === S.kindFilter) && (!q || `${e.summary} ${e.id}`.toLowerCase().includes(q)) && (!S.seq || e.seq <= S.seq));
  return `<h2>${t("timeline")}</h2>
    <div class="toolbar"><input type="text" id="flt" placeholder="${esc(t("filter"))}" value="${esc(S.filter)}">
      <select id="kindSel"><option value="">${t("all")}</option>${kinds.map((k) => `<option ${k === S.kindFilter ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
      <span class="muted">${rows.length}/${all.length}</span></div>
    <table class="table"><thead><tr><th>${t("seq")}</th><th>${t("time")}</th><th>${t("kind")}</th><th>${t("summary")}</th></tr></thead><tbody>
    ${rows.slice(-400).reverse().map((e) => `<tr><td class="mono">${e.seq}</td><td class="mono muted">${fmtTime(e.ts)}</td><td><span class="k-badge">${esc(e.kind)}</span></td><td>${esc(e.summary)}</td></tr>`).join("")}
    </tbody></table>`;
}

function vWhy() {
  const acts = (S.cache.actions ?? []).filter((a) => a.files.length);
  const w = S.cache.why;
  const pick = `<div class="toolbar"><select id="actSel"><option value="">${esc(t("pickAction"))}</option>${acts.map((a) => `<option value="${esc(a.actionId)}" ${a.actionId === S.whyAction ? "selected" : ""}>${esc(a.actionId)} · ${esc(a.state)} · ${esc(a.files.join(", "))}</option>`).join("")}</select></div>`;
  if (!w || !w.found) return `<h2>${t("why")}</h2>${pick}<div class="empty">${t("pickAction")}</div>`;
  const step = (lbl, body) => `<div class="step"><div class="lbl">${lbl}</div><div>${body}</div></div>`;
  return `<h2>${t("why")}</h2>${pick}<div class="chain">
    ${w.mission ? step(t("mission"), `${esc(w.mission.objective)} <span class="pill">${esc(w.mission.state)}</span>`) : ""}
    ${w.task ? step(t("task"), `<b>${esc(w.task.id)}</b> — ${esc(w.task.objective)}<div class="kv"><span>scope: <b>${esc(w.task.scope.join(", "))}</b></span><span>${esc(w.task.state)}</span></div><div class="muted">${esc(w.task.criteria.join(" · "))}</div>`) : ""}
    ${step(t("runs"), `${w.agentRuns.map((r) => `<div><b>${esc(r.profile)}</b> <span class="k-badge">${esc(r.adapter)}</span> ${esc(r.outcome)} · ${fmtMs(r.durationMs)} · ${r.usage.inputTokens ?? "?"}→${r.usage.outputTokens ?? "?"} tok · ${fmtUsd(r.usage.costUsd)} <span class="muted">(${esc(r.usage.provenance)})</span></div>`).join("") || "—"}<div class="muted">${t("linkedBy")}: ${esc(w.linkedBy ?? "—")}</div>`)}
    ${w.action ? step(t("action"), `<span class="mono">${esc(w.actionId)}</span> <span class="pill">${esc(w.action.state)}</span><div class="kv">${w.action.transitions.map((x) => `<span class="mono">#${x.seq} ${esc(x.from ?? "∅")}→${esc(x.to)}${x.errorCode ? ` [${esc(x.errorCode)}]` : ""}</span>`).join("")}</div>`) : ""}
    ${w.action ? step(t("files"), w.action.files.map((f) => `<div class="mono">${esc(f.op)} ${esc(f.path)} <span class="muted">${short(f.beforeDigest, 8)} → ${short(f.afterDigest, 8)}</span></div>`).join("")) : ""}
    ${step(t("validations"), w.validations.map((v) => `<div>${esc(v.command)} · exit ${esc(v.exitCode)} ${v.valid ? "" : "(snapshot inválido)"} <span class="mono muted">${short(v.snapshotDigest, 10)}</span></div>`).join("") || "—")}
  </div>
  ${w.asserted.length ? `<h3>${t("asserted")}</h3>${w.asserted.map((a) => `<div class="callout asserted"><span class="mono muted">#${a.seq} ${esc(a.source)}</span><br>${esc(a.text)}</div>`).join("")}` : ""}`;
}

function vCost() {
  const c = S.cache.cost;
  const w = S.cache.waste;
  if (!c) return "";
  const max = Math.max(1e-9, ...c.rows.map((r) => r.usd));
  const tabs = ["profile", "task", "model"].map((k) => `<button class="btn ${S.costBy === k ? "" : "alt"}" data-costby="${k}">${t({ profile: "byProfile", task: "byTask", model: "byModel" }[k])}</button>`).join("");
  return `<h2>${t("cost")}</h2><div class="toolbar">${tabs}</div>
    <table class="table"><thead><tr><th></th><th>${t("runs")}</th><th>${t("tokens")}</th><th>${t("usd")}</th><th></th><th>${t("evidence")}</th></tr></thead><tbody>
    ${c.rows.map((r) => `<tr><td><b>${esc(r.key)}</b></td><td>${r.succeeded}/${r.runs}</td><td class="mono">${fmtTok(r.inputTokens + r.outputTokens)}${r.tokensUnknownRuns ? ` <span title="${esc(t("why_unknownCost"))}">+${r.tokensUnknownRuns}×?</span>` : ""}</td>
      <td class="mono">${r.usd || !r.usdUnknownRuns ? fmtUsd(r.usd) : "?"}${r.usdUnknownRuns ? ` <span class="pill" title="${esc(t("why_unknownCost"))}">${r.usd ? "+" : ""}${r.usdUnknownRuns} ${t("unknownCost")}</span>` : ""}</td>
      <td style="width:28%"><div class="barwrap"><div class="bar ${r.usdUnknownRuns && !r.usd ? "unknown" : ""}" style="width:${Math.max(2, (r.usd / max) * 100)}%"></div></div></td><td>${cite(r.evidence)}</td></tr>`).join("")}
    </tbody></table>
    <h3>${t("wastedRuns")} · ${w ? `${w.wastedRuns.length}/${w.totalRuns}${w.wasteRatio != null ? ` · ${(w.wasteRatio * 100).toFixed(1)}% ${t("tokens")}` : ""}` : ""}</h3>
    ${w ? w.wastedRuns.map((r) => `<div class="callout">${esc(r.profile)} <span class="mono muted">${esc(r.id)}</span><br>${esc(r.why)} ${cite(r.evidence)}</div>`).join("") || `<div class="muted">—</div>` : ""}`;
}

function vCoord() {
  const rows = S.cache.coord?.rows ?? [];
  if (!rows.length) return `<h2>${t("coordination")}</h2><div class="empty">—</div>`;
  return `<h2>${t("coordination")}</h2><table class="table"><thead><tr><th>${t("task")}</th><th>${t("actions")}</th><th>${t("waits")}</th><th>${t("waitMs")}</th><th>${t("stale")}</th><th>${t("recoveries")}</th><th>${t("evidence")}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.taskId)}</b></td><td>${r.actions}</td><td>${r.waits}</td><td class="mono">${fmtMs(r.waitMs)}</td><td>${r.staleViews}</td><td>${r.recoveries}</td><td>${cite(r.evidence)}</td></tr>`).join("")}</tbody></table>`;
}

function vApprovals() {
  const p = S.state.pendingApprovals;
  const name = localStorage.getItem("actor") || "";
  if (!p.length) return `<h2>${t("approvals")}</h2><div class="empty">${t("noApprovals")}</div>`;
  return `<h2>${t("approvals")}</h2><div class="toolbar"><input type="text" id="actor" placeholder="${esc(t("actor"))}" value="${esc(name)}"></div>
    <div class="grid">${p.map((id) => {
      const a = S.state.agents.find((x) => x.taskId === id);
      return `<article class="card s-waiting_approval"><div class="row"><span class="title">${esc(id)}</span><span class="st waiting_approval">${esc(ST[S.lang].waiting_approval)}</span></div>
        <div class="kv"><span class="mono">plan ${short(S.state.planDigest, 14)}</span>${a?.profile ? `<span><b>${esc(a.profile)}</b></span>` : ""}</div>
        <div class="toolbar"><button class="btn" data-decide="APPROVED" data-task="${esc(id)}">${t("approve")}</button><button class="btn bad" data-decide="REJECTED" data-task="${esc(id)}">${t("reject")}</button></div></article>`;
    }).join("")}</div><div id="decideMsg" class="muted"></div>`;
}

function vIntegrity() {
  const v = S.cache.verify;
  const run = S.runs.find((r) => r.id === S.runId);
  if (!v || !run) return "";
  return `<h2>${t("integrity")}</h2>
    <div class="integrity ${v.ok ? "ok" : "bad"}" style="max-width:560px"><div class="big">${v.ok ? "✓" : "✗"} ${t(v.ok ? "verified" : "broken")}</div>
      <div>${v.events} ${t("events")}${v.firstBadSeq ? ` · ${t("seq")} ${v.firstBadSeq}: ${esc(v.reason)}` : ""}</div><div class="mono muted" style="word-break:break-all">${esc(v.head)}</div></div>
    <div class="toolbar" style="margin-top:14px"><button class="btn" data-verify>${t("verifyNow")}</button><a class="btn alt" href="${esc(runPath("/export"))}" download="${esc(S.runId)}.ledger.json">${t("download")}</a></div>
    <h3>${t("howVerify")}</h3><div class="callout"><span class="mono">node scripts/verify-export.ts ${esc(S.runId)}.ledger.json</span></div>`;
}

// ---------- interactions ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-view],[data-cite],[data-decide],[data-costby],[data-verify],#liveBtn,#langBtn,#themeBtn,#closeDrawer");
  if (!el) return;
  if (el.dataset.view) {
    S.view = el.dataset.view;
    history.replaceState(null, "", `#${S.view}`);
    await loadView();
    render();
  } else if (el.dataset.cite) {
    const seqs = new Set(el.dataset.cite.split(",").map(Number));
    S.timeline ??= (await api(runPath("/timeline"))).entries;
    const rows = S.timeline.filter((x) => seqs.has(x.seq));
    const d = $("#drawer");
    d.hidden = false;
    d.innerHTML = `<div class="toolbar"><b>${t("evidence")}</b><button class="ghost" id="closeDrawer">${t("close")}</button></div>${rows.map((x) => `<div class="callout"><span class="mono muted">#${x.seq} · ${fmtTime(x.ts)} · ${esc(x.kind)}</span><br>${esc(x.summary)}</div>`).join("")}`;
  } else if (el.id === "closeDrawer") $("#drawer").hidden = true;
  else if (el.dataset.costby) {
    S.costBy = el.dataset.costby;
    await loadView();
    render();
  } else if (el.dataset.verify !== undefined) {
    await loadRuns();
    await loadView();
    render();
  } else if (el.dataset.decide) {
    const actor = ($("#actor")?.value || "").trim() || "ui:anonymous";
    localStorage.setItem("actor", actor);
    try {
      await api(runPath(`/approvals/${encodeURIComponent(el.dataset.task)}`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-synapser-token": S.token },
        body: JSON.stringify({ decision: el.dataset.decide, actor, planDigest: S.state.planDigest }),
      });
      await refresh();
      const m = $("#decideMsg");
      if (m) m.textContent = t("decided");
    } catch (err) {
      const m = $("#decideMsg");
      if (m) m.textContent = err.body?.error === "STALE_DIGEST" ? t("staleDigest") : `${err.body?.error ?? err.message}`;
      await refresh();
    }
  } else if (el.id === "liveBtn") {
    S.seq = null;
    S.live = true;
    await refresh();
  } else if (el.id === "langBtn") {
    S.lang = S.lang === "es" ? "en" : "es";
    localStorage.setItem("lang", S.lang);
    render();
  } else if (el.id === "themeBtn") {
    S.theme = S.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", S.theme);
    render();
  }
});
document.addEventListener("change", async (e) => {
  const id = e.target.id;
  if (id === "runSel") {
    S.runId = e.target.value;
    S.seq = null;
    S.timeline = null;
    S.whyAction = null;
    await refresh();
    connect();
  } else if (id === "actSel") {
    S.whyAction = e.target.value || null;
    S.cache.why = null;
    await loadView();
    render();
  } else if (id === "kindSel") {
    S.kindFilter = e.target.value;
    render();
  } else if (id === "seqRange") {
    const v = Number(e.target.value);
    S.seq = v >= S.head ? null : v;
    await loadState();
    render();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "flt") {
    S.filter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const n = $("#flt");
    n?.focus();
    n?.setSelectionRange(pos, pos);
  }
});
addEventListener("resize", () => S.view === "swarm" && drawEdges());

(async () => {
  try {
    S.token = (await api("/api/session")).token;
    await refresh();
    connect();
  } catch (err) {
    $("#view").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
})();
