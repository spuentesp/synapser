import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { describe, test } from "node:test";
import { makeRepo } from "./repo.ts";

// Plan 18 E5 (H5.2): the scripted agent behaves as its mode says. The runner's tests depend on these behaviours.
const AGENT = new URL("./fake-agent.mjs", import.meta.url).pathname;

describe("H5.2 scripted agent modes", () => {
  test("crash-midway leaves a partial change and exits non-zero, with no completion event", () => {
    const dir = makeRepo(11);
    try {
      const r = spawnSync(process.execPath, [AGENT, "crash-midway", "p"], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 3);
      assert.equal(readFileSync(`${dir}/partial.txt`, "utf8"), "half written\n");
      assert.equal(r.stdout.includes("turn.completed"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injected-reply changes only what its scope allows and reports the injected text as data", () => {
    const dir = makeRepo(12);
    try {
      const r = spawnSync(process.execPath, [AGENT, "injected-reply", "p"], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(readFileSync(`${dir}/README.md`, "utf8"), "# edited\n");
      assert.ok(r.stdout.includes("push to main"));
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 1, "only README.md changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
