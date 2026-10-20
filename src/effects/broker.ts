// The effect broker (plan 13 §5): agents REQUEST side effects; this is the only place that performs
// them, with credentials no agent ever holds. Lifecycle, all on the ledger:
//
//   request → policy decides → allow:            EXECUTING → DONE | FAILED
//                              ask:    PENDING → (human decision) → EXECUTING | DENIED | EXPIRED | STALE
//                              deny:   DENIED   (no channel can approve it)
//
// An approval is bound to the digest of the EXACT effect (head sha, branch, remote…): recomputed at
// execution, a mismatch is STALE and nothing runs. Each approval is spent once.

import type { Journal } from "../journal/journal.ts";
import { approvalStatus, requestApproval } from "../orchestration/gates.ts";
import { type Channel, type Decision, evaluate, type Policy, policyHash } from "./policy.ts";
import { BUILTIN_KINDS, effectDigest, EffectFailure, type EffectKind, type Exec, realExec } from "./kinds.ts";

export type EffectState = "PENDING" | "DENIED" | "EXECUTING" | "DONE" | "FAILED" | "STALE" | "EXPIRED" | "REJECTED";

export interface EffectRecord {
  id: string;
  kind: string;
  state: EffectState;
  params: Record<string, unknown>;
  summary: string;
  digest: string;
  requestedBy: string;
  taskId: string | null;
  decision: Decision;
  rule: string | null;
  policyHash: string;
  channels: Channel[];
  reason: string | null;
  evidence: Record<string, unknown> | null;
  requestedSeq: number;
}

export type RequestResult =
  | { ok: true; id: string; state: EffectState; decision: Decision; summary: string; rule: string | null }
  | { ok: false; code: string; errors?: string[] };

export interface BrokerOptions {
  journal: Journal;
  runId: string;
  repoRoot: string;
  policy: () => Policy;
  kinds?: readonly EffectKind[];
  exec?: Exec;
  /** The broker's environment: the user's git/ssh/gh credentials live HERE. */
  env?: NodeJS.ProcessEnv;
  identity?: { name: string; email: string };
  fetch?: typeof fetch;
  now?: () => number;
  /** Who may ask for what, decided before the policy (plan 19 RCP6i). A string refuses the request with that reason. */
  authorize?: (r: { kind: string; params: Record<string, unknown>; role: string | null; taskId: string | null; requestedBy: string }) => string | null;
}

const key = (id: string): string => `effect:${id}`;

export class EffectBroker {
  readonly #o: BrokerOptions;
  readonly #kinds = new Map<string, EffectKind>();
  readonly #inflight = new Set<string>();
  #n = 0;

  constructor(o: BrokerOptions) {
    this.#o = o;
    for (const k of o.kinds ?? BUILTIN_KINDS) this.#kinds.set(k.kind, k);
    // continue numbering after a restart
    this.#n = o.journal.listEvents().filter((e) => e.entity === "effect" && e.fromState === null).length;
    this.#recordPolicy();
  }

  get #ctx() {
    return {
      repoRoot: this.#o.repoRoot,
      exec: this.#o.exec ?? realExec,
      env: this.#o.env ?? process.env,
      identity: this.#o.identity ?? { name: "Synapser", email: "synapser@localhost" },
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
    };
  }
  #now = (): number => (this.#o.now ?? Date.now)();

  /** The policy document is a ledger fact: every decision cites its hash and the hash resolves here. */
  #recordPolicy(): string {
    const p = this.#o.policy();
    const h = policyHash(p);
    const known = this.#o.journal.listEvents().some((e) => e.entity === "policy" && e.entityId === h);
    if (!known) {
      const blob = this.#o.journal.artifacts.put(Buffer.from(JSON.stringify(p), "utf8"));
      this.#o.journal.tx((t) => t.event(this.#o.runId, "policy", h, null, "IN_FORCE", { blob, rules: p.rules.length, default: p.default }));
    }
    return h;
  }

  async request(r: { kind: string; params: unknown; requestedBy: string; taskId?: string | null; role?: string | null }): Promise<RequestResult> {
    const impl = this.#kinds.get(r.kind);
    if (!impl) {
      // an unknown kind is DENIED by policy default: record it, do not even prepare it
      const id = `ef-${++this.#n}`;
      const h = this.#recordPolicy();
      this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, null, "DENIED", { kind: r.kind, requested_by: r.requestedBy, task_id: r.taskId ?? null, policy_hash: h, rule: null, decision: "deny", reason: "unknown effect kind", params: {}, summary: "", digest: "" }));
      return { ok: true, id, state: "DENIED", decision: "deny", summary: "", rule: null };
    }
    const v = impl.validate(r.params);
    if (!v.ok) return { ok: false, code: "INVALID_PARAMS", errors: v.errors };
    const refusal = this.#o.authorize?.({ kind: r.kind, params: v.params, role: r.role ?? null, taskId: r.taskId ?? null, requestedBy: r.requestedBy });
    if (refusal) {
      // refused before the policy: recorded like any denial, with the reason, and nothing is prepared or run
      const id = `ef-${++this.#n}`;
      const h = this.#recordPolicy();
      this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, null, "DENIED", { kind: r.kind, requested_by: r.requestedBy, task_id: r.taskId ?? null, policy_hash: h, rule: null, decision: "deny", reason: refusal, params: v.params, summary: "", digest: "" }));
      return { ok: true, id, state: "DENIED", decision: "deny", summary: "", rule: null };
    }
    const id = `ef-${++this.#n}`;
    const h = this.#recordPolicy();
    const ev = evaluate(this.#o.policy(), r.kind, v.params);
    const base = { kind: r.kind, requested_by: r.requestedBy, task_id: r.taskId ?? null, policy_hash: h, rule: ev.ruleId, decision: ev.decision, channels: ev.channels, ttl_seconds: ev.ttlSeconds, params: v.params };

    if (ev.decision === "deny") {
      this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, null, "DENIED", { ...base, reason: ev.reason ?? "denied by policy", summary: "", digest: "" }));
      return { ok: true, id, state: "DENIED", decision: "deny", summary: "", rule: ev.ruleId };
    }
    let prepared;
    try {
      prepared = await impl.prepare(v.params, this.#ctx);
    } catch (e) {
      const code = e instanceof EffectFailure ? e.code : "PREPARE_FAILED";
      const msg = String((e as Error).message ?? e).slice(0, 300);
      this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, null, "FAILED", { ...base, reason: `${code}: ${msg}`, summary: "", digest: "" }));
      return { ok: true, id, state: "FAILED", decision: ev.decision, summary: msg, rule: ev.ruleId };
    }
    const digest = effectDigest(r.kind, prepared);
    const state: EffectState = ev.decision === "ask" ? "PENDING" : "EXECUTING";
    this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, null, state, { ...base, summary: prepared.summary, digest, details: prepared.details, reason: null }));
    if (ev.decision === "ask") requestApproval(this.#o.journal, this.#o.runId, key(id), digest, prepared.summary);
    else void this.#execute(id).catch(() => {});
    return { ok: true, id, state, decision: ev.decision, summary: prepared.summary, rule: ev.ruleId };
  }

  records(): EffectRecord[] {
    const by = new Map<string, EffectRecord>();
    for (const e of this.#o.journal.listEvents()) {
      if (e.entity !== "effect") continue;
      const d = e.data as Record<string, unknown>;
      const cur = by.get(e.entityId);
      if (!cur) {
        by.set(e.entityId, {
          id: e.entityId, kind: String(d["kind"]), state: e.toState as EffectState, params: (d["params"] ?? {}) as Record<string, unknown>,
          summary: String(d["summary"] ?? ""), digest: String(d["digest"] ?? ""), requestedBy: String(d["requested_by"]), taskId: (d["task_id"] as string | null) ?? null,
          decision: d["decision"] as Decision, rule: (d["rule"] as string | null) ?? null, policyHash: String(d["policy_hash"]),
          channels: (d["channels"] as Channel[] | undefined) ?? [], reason: (d["reason"] as string | null) ?? null, evidence: null, requestedSeq: e.seq,
        });
      } else {
        cur.state = e.toState as EffectState;
        if (d["reason"]) cur.reason = String(d["reason"]);
        if (d["evidence"]) cur.evidence = d["evidence"] as Record<string, unknown>;
      }
    }
    return [...by.values()];
  }

  status(id: string): EffectRecord | null {
    return this.records().find((r) => r.id === id) ?? null;
  }

  /** Spend decisions: execute what a human approved, expire what waited too long, refuse what drifted. */
  async tick(): Promise<void> {
    for (const r of this.records().filter((x) => x.state === "PENDING")) {
      const st = approvalStatus(this.#o.journal, key(r.id), r.digest);
      if (st === "REJECTED") {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", r.id, "PENDING", "REJECTED", { reason: "rejected by a human" }));
        continue;
      }
      if (st !== "APPROVED") continue;
      const approved = this.#o.journal.listEvents().filter((e) => e.entity === "approval" && e.entityId === key(r.id) && e.toState === "APPROVED").at(-1)!;
      const ttl = Number((this.#o.journal.listEvents().find((e) => e.entity === "effect" && e.entityId === r.id)!.data as { ttl_seconds?: number }).ttl_seconds ?? 900);
      if (this.#now() - approved.ts > ttl * 1000) {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", r.id, "PENDING", "EXPIRED", { reason: `the approval expired after ${ttl}s` }));
        continue;
      }
      // channel policy: an approval through a channel the rule does not allow does not count
      const ch = String((approved.data as { channel?: string }).channel ?? "ui") as Channel;
      if (r.channels.length && !r.channels.includes(ch)) {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", r.id, "PENDING", "REJECTED", { reason: `channel "${ch}" is not allowed by rule ${r.rule ?? "(default)"}` }));
        continue;
      }
      await this.#execute(r.id, { approvalSeq: approved.seq, channel: ch });
    }
  }

  async #execute(id: string, via: { approvalSeq?: number; channel?: string } = {}): Promise<void> {
    if (this.#inflight.has(id)) return;
    this.#inflight.add(id);
    try {
      const r = this.status(id)!;
      if (r.state !== "PENDING" && r.state !== "EXECUTING") return; // each effect runs at most once
      const impl = this.#kinds.get(r.kind)!;
      // freshness: recompute from the real world; what was approved must be what is about to happen
      let prepared;
      try {
        prepared = await impl.prepare(r.params, this.#ctx);
      } catch (e) {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, r.state, "STALE", { reason: `cannot re-verify: ${String((e as Error).message ?? e).slice(0, 200)}` }));
        return;
      }
      if (effectDigest(r.kind, prepared) !== r.digest) {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, r.state, "STALE", { reason: "STALE_EFFECT: the repository changed since this was approved", now_summary: prepared.summary }));
        return;
      }
      if (r.state === "PENDING") {
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, "PENDING", "EXECUTING", { by: "broker", digest: r.digest, ...(via.approvalSeq ? { approval_seq: via.approvalSeq, channel: via.channel } : {}) }));
      }
      try {
        const evidence = await impl.execute(r.params, prepared, this.#ctx);
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, "EXECUTING", "DONE", { by: "broker", evidence }));
      } catch (e) {
        const code = e instanceof EffectFailure ? e.code : "EXECUTION_FAILED";
        this.#o.journal.tx((t) => t.event(this.#o.runId, "effect", id, "EXECUTING", "FAILED", { by: "broker", reason: `${code}: ${String((e as Error).message ?? e).slice(0, 300)}` }));
      }
    } finally {
      this.#inflight.delete(id);
    }
  }
}
