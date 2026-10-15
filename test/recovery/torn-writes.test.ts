import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, test } from "node:test";
import { recoverRun } from "../../src/executor/recovery.ts";
import { type Env, BASELINE, reopenEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { BILLING_AFTER, fresh, runChild } from "./support.ts";

// Plan 18 E11 (H11.2), part: a torn write. The executor is killed after it has written the temporary files and before any
// rename (the after-temp-written failpoint). Each temporary file is then cut short at a point chosen by the seed, which is
// what a power cut during a write leaves behind. Recovery must finish the action with the complete content, leave no
// temporary file behind, and keep every invariant. Missing fsync is NOT covered here: it needs a filesystem layer that can
// lose unsynced data, which this harness does not have.
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

// A seeded cut point strictly inside the file, so the file is always torn (never empty, never whole).
const cutFor = (seed: number, index: number, size: number): number => {
  const frac = (seed * 0.618034 + index * 0.31) % 1;
  return Math.min(size - 1, Math.floor(frac * size));
};

// Regular files only, relative to root, sorted: directories are not temporaries.
const listFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)))
    .sort();

describe("H11.2 a torn temporary file is never the result: recovery completes the write from the journal", () => {
  const open: Env[] = [];
  afterEach(async () => {
    for (const e of open.splice(0)) await e.close();
  });

  for (const seed of SEEDS) {
    test(`seed ${seed}: torn temporaries are rewritten, nothing torn is kept`, async () => {
      const { ws, state } = fresh();
      try {
        const died = await runChild(state, ws, "two-files", "after-temp-written");
        assert.equal(died.signal, "SIGKILL", "the child must die at the failpoint");

        // The temporaries are the ones the journal names for the open action, not every new file: Zoanthrope keeps its own state in the workspace.
        const env = await reopenEnv(ws, state);
        open.push(env);
        // The coordination registry is read before recovery, as in crash-matrix.test.ts.
        await env.zoo.listClaims();
        // The journal names a temporary for every file of the action, but the crash may have happened before some were written.
        const named = env.journal.listNonTerminal().flatMap((a) => env.journal.getActionFiles(a.actionId)).filter((f) => f.tmpName !== null);
        const existing = named.map((f) => join(ws, dirname(f.path), f.tmpName as string)).filter((p) => existsSync(p));
        assert.ok(existing.length > 0, "the crash left at least one temporary file to tear");
        existing.forEach((full, i) => {
          const bytes = readFileSync(full);
          writeFileSync(full, bytes.subarray(0, cutFor(seed, i, bytes.length)));
        });

        const report = await recoverRun({
          executor: env.exec,
          journal: env.journal,
          zoo: env.zoo,
          workspaceRoot: env.ws,
          runId: RUN,
          generation: env.lock.generation,
        });
        assert.equal(report.degraded, false, JSON.stringify(report.decisions).slice(0, 900));

        const pending = env.journal.listNonTerminal();
        assert.equal(pending.length, 0, "no action is left open");
        assert.equal(env.read("app/billing.py"), BILLING_AFTER, "the billing file holds the complete new content");
        assert.match(env.read("app/schema.py"), /discount_bps: int = 0/, "the schema holds the complete new content");

        const leftovers = listFiles(ws).filter((f) => f.startsWith(".synapser-tmp-") || f.includes("/.synapser-tmp-"));
        assert.deepEqual(leftovers, [], "no temporary file survives recovery");
        assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(state, { recursive: true, force: true });
      }
    });
  }
});
