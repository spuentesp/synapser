// A/B CONTROL: what most multi-agent setups do. Agents read the shared tree, compute a whole-file
// result from what they read, and write it straight back — no claims, no digest check, no
// staleness detection. Last writer wins. It speaks the same WriteGateway port as the Executor and
// feeds the same WriteRecord trace, so both arms are judged by identical invariant checkers.
//
// It deliberately keeps the cheap, obviously-correct protections (path containment, task scope,
// patch must apply to what the agent read): the experiment isolates COORDINATION, not hygiene.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { digestOnDisk, type WriteRecord } from "../audit/invariants.ts";
import type { Edit } from "../digest/canonical.ts";
import { PatchRejected, resolveEdits } from "../digest/edits.ts";
import { ABSENT, type Digest, type DigestOrAbsent, observeFile, sha256Bytes } from "../digest/file.ts";
import type { ActionReceipt, ProposeOutcome, ReadOutcome, TaskCtx } from "../executor/executor.ts";
import { absPath } from "../executor/fs-applier.ts";
import type { WriteGateway } from "../executor/gateway.ts";
import { PathRejected, resolveInWorkspace, resolveSet } from "../workspace/paths.ts";

interface View {
  taskId: string;
  files: Map<string, { digest: DigestOrAbsent; bytes: Buffer | null; mode: number | null }>;
}
interface Proposal {
  taskId: string;
  actor: string;
  resolved: ReturnType<typeof resolveEdits>;
  basedOn: Map<string, DigestOrAbsent>;
  receipt?: ActionReceipt;
}

export class NaiveGateway implements WriteGateway {
  readonly trace: WriteRecord[] = [];
  readonly #root: string;
  readonly #runId: string;
  readonly #tasks = new Map<string, TaskCtx>();
  readonly #views = new Map<string, View>();
  readonly #proposals = new Map<string, Proposal>();
  readonly #count = new Map<string, number>();
  #seq = 0;

  constructor(opts: { workspace: string; runId: string }) {
    this.#root = opts.workspace;
    this.#runId = opts.runId;
  }

  beginSession(task: TaskCtx): { actorOwner: string; incarnation: number } {
    this.#tasks.set(task.taskId, task);
    return { actorOwner: `${this.#runId}:${task.taskId}`, incarnation: 1 };
  }

  async readFiles(taskId: string, _incarnation: number, paths: readonly string[]): Promise<ReadOutcome> {
    let files;
    try {
      files = resolveSet(this.#root, paths);
    } catch (e) {
      if (e instanceof PathRejected) return { kind: "rejected", code: `PATH_${e.code}`, detail: e.input };
      throw e;
    }
    if (files.length === 0) return { kind: "rejected", code: "EMPTY" };
    const view: View = { taskId, files: new Map() };
    const out: Extract<ReadOutcome, { kind: "ok" }>["files"] = [];
    for (const p of files) {
      const o = observeFile(absPath(this.#root, p));
      if (o.kind === "other") return { kind: "rejected", code: "NOT_REGULAR_FILE", detail: p };
      if (o.kind === "absent") {
        view.files.set(p, { digest: ABSENT, bytes: null, mode: null });
        out.push({ path: p, digest: ABSENT, mode: null, content: null, binary: false });
        continue;
      }
      const bytes = readFileSync(absPath(this.#root, p));
      const digest = sha256Bytes(bytes);
      let content: string | null = null;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        /* binary */
      }
      view.files.set(p, { digest, bytes, mode: o.mode });
      out.push({ path: p, digest, mode: o.mode, content, binary: content === null });
    }
    const viewId = `view-${randomUUID()}`;
    this.#views.set(viewId, view);
    return { kind: "ok", viewId, files: out };
  }

  async proposePatch(taskId: string, _incarnation: number, viewId: string | readonly string[], edits: readonly Edit[]): Promise<ProposeOutcome> {
    const task = this.#tasks.get(taskId);
    if (!task) return { kind: "rejected", code: "UNKNOWN_TASK" };
    const merged = new Map<string, View["files"] extends Map<string, infer V> ? V : never>();
    for (const id of typeof viewId === "string" ? [viewId] : viewId) {
      const v = this.#views.get(id);
      if (!v || v.taskId !== taskId) return { kind: "rejected", code: "UNKNOWN_VIEW" };
      for (const [p, f] of v.files) merged.set(p, f);
    }
    if (edits.length === 0) return { kind: "rejected", code: "EMPTY_PATCH" };
    const canon: Edit[] = [];
    try {
      for (const e of edits) {
        const path = resolveInWorkspace(this.#root, e.path);
        const ok = task.scope.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s));
        if (!ok) return { kind: "rejected", code: "OUT_OF_SCOPE", detail: path };
        canon.push({ ...e, path });
      }
    } catch (e) {
      if (e instanceof PathRejected) return { kind: "rejected", code: `PATH_${e.code}`, detail: e.input };
      throw e;
    }
    const bytes = new Map<string, Buffer | null>();
    const basedOn = new Map<string, DigestOrAbsent>();
    for (const e of canon) {
      const f = merged.get(e.path);
      if (f) {
        bytes.set(e.path, f.bytes);
        basedOn.set(e.path, f.digest);
      }
    }
    let resolved;
    try {
      resolved = resolveEdits(bytes, canon);
    } catch (e) {
      if (e instanceof PatchRejected) return { kind: "rejected", code: e.code, detail: e.path };
      throw e;
    }
    const n = (this.#count.get(taskId) ?? 0) + 1;
    this.#count.set(taskId, n);
    const actionId = `act-${taskId}-${n}`;
    const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify({ taskId, canon })).digest("hex")}` as Digest;
    this.#proposals.set(actionId, { taskId, actor: `${this.#runId}:${taskId}`, resolved, basedOn });
    return {
      kind: "ok",
      actionId,
      requestDigest,
      files: resolved.map((r) => ({
        path: r.path,
        op: r.op,
        before: (r.before === null ? ABSENT : sha256Bytes(r.before)) as DigestOrAbsent,
        after: (r.after === null ? ABSENT : sha256Bytes(r.after)) as DigestOrAbsent,
      })),
    };
  }

  async applyAction(req: { actionId: string; requestDigest: Digest; incarnation: number }): Promise<ActionReceipt> {
    const p = this.#proposals.get(req.actionId);
    if (!p) throw new Error(`unknown action ${req.actionId}`);
    if (p.receipt) return p.receipt; // idempotent, like the real one
    const applied: ActionReceipt["applied_files"] = [];
    for (const r of p.resolved) {
      const before = digestOnDisk(this.#root, r.path);
      const written = (r.after === null ? ABSENT : sha256Bytes(r.after)) as DigestOrAbsent;
      this.trace.push({ seq: ++this.#seq, path: r.path, actor: p.actor, basedOn: p.basedOn.get(r.path) ?? ABSENT, onDiskBefore: before, written });
      const abs = absPath(this.#root, r.path);
      if (r.after === null) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, r.after); // last writer wins
      }
      applied.push({ path: r.path, digest: written });
    }
    p.receipt = {
      action_id: req.actionId,
      state: "SETTLED",
      status: "SETTLED",
      error_code: null,
      applied_files: applied,
      observed_files: [],
      waiting: null,
      cleanup: { registry: null, fs: "NOT_ATTESTED" },
    };
    return p.receipt;
  }
}
