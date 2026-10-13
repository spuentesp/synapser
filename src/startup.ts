// Startup sequence (plan 04 §1). One entry point that composes, in order:
//   0 workspace lock  →  journal open + integrity  →  reap stale children  →
//   Zoanthrope G0 + handshake  →  recovery  →  only then accept agent work.
// A failure in Zoanthrope does not crash the process: it yields a DEGRADED executor that reports
// and refuses mutations (design §8, S09). A busy lock is fatal on purpose (S17).

import { type ExecutorDeps, Executor, type ZooPort } from "./executor/executor.ts";
import { type RecoveryReport, recoverRun } from "./executor/recovery.ts";
import { Journal } from "./journal/journal.ts";
import { acquireWorkspaceLock, type WorkspaceLock } from "./journal/lock.ts";
import { type ReapOutcome, reapStaleChildren } from "./recovery/children.ts";
import { type BinaryIdentity, ZooAdapter, type ZooPin } from "./zoo/adapter.ts";
import { ZooError } from "./zoo/types.ts";

export interface StartOptions {
  stateDir: string;
  workspace: string;
  runId: string;
  pin: ZooPin;
  model?: string;
  zooEnv?: NodeJS.ProcessEnv;
  callTimeoutMs?: number;
  failpoint?: ExecutorDeps["failpoint"];
}

export interface Started {
  executor: Executor;
  journal: Journal;
  zoo: ZooPort;
  lock: WorkspaceLock;
  generation: number;
  identity: BinaryIdentity | null;
  /** Why coordination is unavailable, or null when healthy. */
  degradedReason: string | null;
  report: RecoveryReport;
  reaped: ReapOutcome[];
  close(): Promise<void>;
}

/** A coordination port that fails every call, so recovery degrades instead of acting blindly. */
export function unavailableZoo(reason: string): ZooPort {
  const fail = async (): Promise<never> => {
    throw new ZooError("TRANSPORT_CLOSED", reason);
  };
  return { claim: fail, release: fail, listClaims: fail, rejoin: fail };
}

export async function startExecutor(o: StartOptions): Promise<Started> {
  // 0. exclusive ownership of the workspace; LockBusy propagates (no second executor, ever)
  const lock = acquireWorkspaceLock(o.stateDir, o.workspace);
  let journal: Journal | undefined;
  let adapter: ZooAdapter | null = null;
  try {
    // 1. journal: opening it runs quick_check and the schema-version check
    journal = Journal.open(o.stateDir, o.runId);

    // 2. nothing recorded by a previous generation may still be running
    const reaped = await reapStaleChildren(journal, lock.generation);

    // 3. coordination engine: pinned binary, handshake, tools
    let degradedReason: string | null = null;
    let zoo: ZooPort;
    let identity: BinaryIdentity | null = null;
    try {
      adapter = await ZooAdapter.open(o.pin, o.workspace, {
        ...(o.zooEnv ? { env: { ...process.env, ...o.zooEnv } } : {}),
        ...(o.callTimeoutMs ? { callTimeoutMs: o.callTimeoutMs } : {}),
      });
      identity = adapter.identity;
      zoo = adapter;
    } catch (e) {
      if (!(e instanceof ZooError)) throw e;
      degradedReason = `${e.kind}: ${e.message}`;
      zoo = unavailableZoo(degradedReason);
    }

    // 4. executor refuses agent work until recovery has reported
    const executor = new Executor({
      workspace: o.workspace,
      runId: o.runId,
      journal,
      zoo,
      generation: lock.generation,
      requireRecovery: true,
      ...(o.failpoint ? { failpoint: o.failpoint } : {}),
    });
    const report = await recoverRun({
      executor,
      journal,
      zoo,
      workspaceRoot: o.workspace,
      runId: o.runId,
      generation: lock.generation,
      ...(o.model ? { model: o.model } : {}),
    });
    if (report.degraded && !degradedReason) degradedReason = "coordination became unavailable during recovery";

    const j = journal;
    const a = adapter;
    return {
      executor,
      journal: j,
      zoo,
      lock,
      generation: lock.generation,
      identity,
      degradedReason,
      report,
      reaped,
      async close() {
        if (a) await a.close();
        j.close();
        lock.release();
      },
    };
  } catch (e) {
    // never leave the lock held by a half-started process
    if (adapter) await adapter.close().catch(() => undefined);
    journal?.close();
    lock.release();
    throw e;
  }
}

