// One executor per workspace (design §3, S17). The lock is an exclusive SQLite lock held for
// the whole process lifetime: the kernel drops it when the process dies, even on SIGKILL, so
// there is no stale pidfile and no pid-reuse race. It lives at the ROOT of the state dir,
// above the per-run directories, so two different run_ids cannot each take "their own" lock.

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class LockBusy extends Error {
  constructor(path: string) {
    super(`another executor holds the workspace lock: ${path}`);
    this.name = "LockBusy";
  }
}

export interface WorkspaceLock {
  /** Monotonic across acquisitions of this lock; sessions record the generation they were born in. */
  readonly generation: number;
  readonly path: string;
  release(): void;
}

export function acquireWorkspaceLock(stateDir: string, workspace: string): WorkspaceLock {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "lock.db");
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    // EXCLUSIVE locking mode keeps the OS lock for the connection's lifetime, past COMMIT.
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("PRAGMA synchronous=FULL");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS lock_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const ws = realpathSync(workspace);
    const known = db.prepare("SELECT value FROM lock_meta WHERE key='workspace'").get() as { value: string } | undefined;
    if (known && known.value !== ws) {
      throw new Error(`state dir ${stateDir} belongs to workspace ${known.value}, not ${ws}`);
    }
    db.prepare("INSERT OR REPLACE INTO lock_meta VALUES('workspace', ?)").run(ws);
    const cur = db.prepare("SELECT value FROM lock_meta WHERE key='generation'").get() as { value: string } | undefined;
    const generation = (cur ? Number(cur.value) : 0) + 1;
    db.prepare("INSERT OR REPLACE INTO lock_meta VALUES('generation', ?)").run(String(generation));
    db.exec("COMMIT");
    return {
      generation,
      path,
      release: () => {
        if (db.isOpen) db.close();
      },
    };
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    const msg = String((e as Error)?.message ?? e);
    if (/locked|busy/i.test(msg)) throw new LockBusy(path);
    throw e;
  }
}
