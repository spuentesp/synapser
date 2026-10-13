import { cpSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor, type ExecutorDeps, type TaskCtx, type ZooPort } from "../../src/executor/executor.ts";
import type { FailpointName } from "../../src/failpoints.ts";
import { Journal } from "../../src/journal/journal.ts";
import { acquireWorkspaceLock, type WorkspaceLock } from "../../src/journal/lock.ts";
import { ZooAdapter } from "../../src/zoo/adapter.ts";
import { loadPin } from "../../src/zoo/pin.ts";

export const RUN = "run-42";
export const BASELINE = new URL("../../fixtures/billing/baseline", import.meta.url).pathname;

export interface Gate {
  reached: Promise<void>;
  open(): void;
}

export interface Env {
  ws: string;
  state: string;
  journal: Journal;
  zoo: ZooAdapter;
  lock: WorkspaceLock;
  exec: Executor;
  /** Hold the given action at the given point until `open()`; resolves `reached` when it gets there. */
  gate(name: FailpointName, actionId: string): Gate;
  read(rel: string): string;
  write(rel: string, body: string): void;
  close(): Promise<void>;
}

export interface EnvOpts {
  env?: NodeJS.ProcessEnv;
  requireRecovery?: boolean;
  zoo?: (real: ZooAdapter) => ZooPort;
  beforeRename?: ExecutorDeps["beforeRename"];
}

export async function makeEnv(opts: EnvOpts = {}): Promise<Env> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "synapser-ws-")));
  cpSync(BASELINE, ws, { recursive: true });
  const state = realpathSync(mkdtempSync(join(tmpdir(), "synapser-state-")));
  return buildEnv(ws, state, opts);
}

/** Open an executor on an EXISTING workspace/state dir (what a restarted process does). */
export async function reopenEnv(ws: string, state: string, opts: EnvOpts = {}): Promise<Env> {
  return buildEnv(ws, state, opts);
}

async function buildEnv(ws: string, state: string, opts: EnvOpts): Promise<Env> {
  const lock = acquireWorkspaceLock(state, ws);
  const journal = Journal.open(state, RUN);
  const zoo = await ZooAdapter.open(loadPin(), ws, opts.env ? { env: { ...process.env, ...opts.env } } : {});
  const gates = new Map<string, { promise: Promise<void>; reached: () => void }>();
  const exec = new Executor({
    workspace: ws,
    runId: RUN,
    journal,
    zoo: opts.zoo ? opts.zoo(zoo) : zoo,
    generation: lock.generation,
    ...(opts.requireRecovery ? { requireRecovery: true } : {}),
    failpoint: async (name, { actionId }) => {
      const g = gates.get(`${name}:${actionId}`);
      if (g) {
        g.reached();
        await g.promise;
      }
    },
    ...(opts.beforeRename ? { beforeRename: opts.beforeRename } : {}),
  });
  return {
    ws,
    state,
    journal,
    zoo,
    lock,
    exec,
    gate(name, actionId) {
      let open!: () => void;
      let reached!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      const reachedP = new Promise<void>((r) => (reached = r));
      gates.set(`${name}:${actionId}`, { promise, reached });
      return { reached: reachedP, open };
    },
    read: (rel) => readFileSync(join(ws, rel), "utf8"),
    write: (rel, body) => writeFileSync(join(ws, rel), body),
    async close() {
      await zoo.close();
      journal.close();
      lock.release();
    },
  };
}

export const mtimeNs = (env: Env, rel: string) => statSync(join(env.ws, rel), { bigint: true }).mtimeNs;
export const ino = (env: Env, rel: string) => statSync(join(env.ws, rel)).ino;

export const T1: TaskCtx = { taskId: "t1", scope: ["app/billing.py", "app/schema.py"], planRevision: 1 };
export const T2: TaskCtx = { taskId: "t2", scope: ["app/client.py", "app/schema.py"], planRevision: 1 };
export const T3: TaskCtx = { taskId: "t3", scope: ["tests/", "README.md"], planRevision: 1 };

/** read → propose in one go; returns what apply needs. */
export async function propose(env: Env, task: TaskCtx, incarnation: number, paths: string[], edits: import("../../src/digest/canonical.ts").Edit[]) {
  const r = await env.exec.readFiles(task.taskId, incarnation, paths);
  if (r.kind !== "ok") throw new Error(`read failed: ${JSON.stringify(r)}`);
  const p = await env.exec.proposePatch(task.taskId, incarnation, r.viewId, edits);
  if (p.kind !== "ok") throw new Error(`propose failed: ${JSON.stringify(p)}`);
  return p;
}
