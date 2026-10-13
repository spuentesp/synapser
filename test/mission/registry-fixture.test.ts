// The workload's own contract: the oracle rejects the stubs and accepts the reference solution,
// the plan really is "N tasks, one shared file", and the stubs are independent of each other.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { REGISTRY_FUNCTIONS, registryAcceptance, registryPlan } from "../../src/mission/registry-fixture.ts";
import { validatePlan } from "../../src/mission/plan.ts";

const FX = resolve("fixtures/registry");
const oracle = (tree: string) => {
  const cmd = registryAcceptance(FX)[0]!;
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), { cwd: tree, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" } });
  return { ok: r.status === 0, out: r.stderr };
};
const copy = (kind: string) => {
  const d = mkdtempSync(join(tmpdir(), "reg-fx-"));
  cpSync(join(FX, kind), d, { recursive: true });
  return d;
};

test("oracle rejects the baseline and accepts the reference solution", () => {
  const b = copy("baseline");
  const s = copy("solution");
  try {
    const rb = oracle(b);
    assert.equal(rb.ok, false);
    assert.match(rb.out, /errors=8/, "every one of the eight functions is required");
    assert.equal(oracle(s).ok, true);
  } finally {
    rmSync(b, { recursive: true, force: true });
    rmSync(s, { recursive: true, force: true });
  }
});

test("a single implemented function turns exactly one oracle test green (the stubs are independent)", () => {
  const b = copy("baseline");
  try {
    const sol = readFileSync(join(FX, "solution/app/handlers.py"), "utf8");
    const base = readFileSync(join(b, "app/handlers.py"), "utf8");
    // take ONLY the clamp function from the solution
    const grab = (src: string) => /def clamp\([\s\S]*?(?=\n\n# -{70,}|\s*$)/.exec(src)![0];
    const merged = base.replace(grab(base), grab(sol));
    assert.notEqual(merged, base);
    writeFileSync(join(b, "app/handlers.py"), merged);
    assert.match(oracle(b).out, /errors=7/);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("the plan is N independent tasks that all share one file and are each scoped to it", () => {
  const plan = registryPlan();
  assert.equal(plan.tasks.length, REGISTRY_FUNCTIONS.length);
  assert.ok(plan.tasks.every((t) => t.deps.length === 0 && t.scope.length === 1 && t.scope[0] === "app/handlers.py"));
  const check = validatePlan(plan, { workspaceRoot: join(FX, "baseline") });
  assert.equal(check.ok, true, JSON.stringify(check));
});
