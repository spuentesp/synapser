// The oracle must reject the baseline and accept the reference solution; otherwise it
// proves nothing about a run (design §16 "Oracle independiente del modelo").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const FX = resolve("fixtures/billing");

function runOracle(candidate: string) {
  // cwd = candidate so `python -m` puts the candidate tree (and only it) on sys.path.
  return spawnSync("python3", ["-m", "unittest", "discover", "-s", join(FX, "oracle")], {
    cwd: candidate,
    env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
}
function runOwnTests(candidate: string) {
  return spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."], {
    cwd: candidate,
    env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
}
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "billing-"));
  cpSync(join(FX, "baseline"), d, { recursive: true });
  return d;
};

test("baseline passes its own tests but FAILS the oracle", () => {
  const d = fresh();
  assert.equal(runOwnTests(d).status, 0);
  assert.notEqual(runOracle(d).status, 0);
});

test("reference solution passes the oracle and its own tests", () => {
  const d = fresh();
  cpSync(join(FX, "solution"), d, { recursive: true });
  const o = runOracle(d);
  assert.equal(o.status, 0, o.stderr);
  const t = runOwnTests(d);
  assert.equal(t.status, 0, t.stderr);
});
