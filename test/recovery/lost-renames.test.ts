import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { recoverRun } from "../../src/executor/recovery.ts";
import { BASELINE, type Env, reopenEnv, RUN } from "../executor/env.ts";
import { checkInvariants } from "../executor/invariants.ts";
import { BILLING_AFTER, fresh, runChild } from "./support.ts";

// Plan 18 E11 (H11.2), part: a rename that was never made durable. Without fsync of the directory, a power cut can
// undo a rename: the file keeps its old content at its name, and the new content is still under the temporary name.
// The executor is killed after one or more renames; for each renamed file, a seeded choice undoes its rename. Recovery
// must finish the action with the complete new content, leave no temporary behind, and keep the invariants.
// Missing fsync of the file's data is covered by torn-writes.test.ts.
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const POINTS = ["after-first-rename", "between-renames", "after-last-rename"] as const;
let undoneInTotal = 0;

describe("H11.2 an undone rename is finished by recovery from the journal", () => {
  for (const seed of SEEDS) {
    const point = POINTS[seed % POINTS.length]!;
    test(`seed ${seed} at ${point}: undone renames are restored to the staged content, then completed`, async () => {
      const { ws, state } = fresh();
      let env: Env | undefined;
      try {
        const died = await runChild(state, ws, "two-files", point);
        assert.equal(died.signal, "SIGKILL", "the child must die at the failpoint");

        env = await reopenEnv(ws, state);
        await env.zoo.listClaims();
        const named = env.journal.listNonTerminal().flatMap((a) => env!.journal.getActionFiles(a.actionId)).filter((f) => f.tmpName !== null);
        let undone = 0;
        named.forEach((f, i) => {
          const final = join(ws, f.path);
          const tmp = join(ws, dirname(f.path), f.tmpName as string);
          const renamed = existsSync(final) && readFileSync(final, "utf8") !== readFileSync(join(BASELINE, f.path), "utf8");
          if (!renamed || (seed + i) % 2 !== 0) return;
          // The rename is lost: the new bytes are back under the temporary name, the old bytes under the final name.
          const after = readFileSync(final);
          writeFileSync(tmp, after);
          const before = existsSync(join(BASELINE, f.path)) ? readFileSync(join(BASELINE, f.path)) : null;
          if (before === null) unlinkSync(final);
          else writeFileSync(final, before);
          undone++;
        });
        undoneInTotal += undone;

        const report = await recoverRun({
          executor: env.exec, journal: env.journal, zoo: env.zoo, workspaceRoot: env.ws, runId: RUN, generation: env.lock.generation,
        });
        assert.equal(report.degraded, false, JSON.stringify(report.decisions).slice(0, 900));
        assert.equal(env.journal.listNonTerminal().length, 0, "no action is left open");
        assert.equal(env.read("app/billing.py"), BILLING_AFTER, "the billing file holds the complete new content");
        assert.match(env.read("app/schema.py"), /discount_bps: int = 0/, "the schema holds the complete new content");
        for (const f of named) {
          const tmp = join(ws, dirname(f.path), f.tmpName as string);
          assert.equal(existsSync(tmp), false, `no temporary left: ${tmp}`);
        }
        assert.deepEqual(await checkInvariants(env, { expectNoClaims: true }), []);
      } finally {
        if (env) await env.close();
        rmSync(ws, { recursive: true, force: true });
        rmSync(state, { recursive: true, force: true });
      }
    });
  }

  test("across the seeds, at least one rename was really undone, so the cases are not vacuous", () => {
    assert.ok(undoneInTotal > 0, `renames undone: ${undoneInTotal}`);
  });
});
