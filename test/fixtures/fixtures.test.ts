import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { makeRepo, treeDigest } from "./repo.ts";
import { startFakeLlm } from "./fake-llm.ts";

// Plan 18 E5: the fixtures are reproducible and do what they say.
describe("H5.1 and H5.5: repositories are reproducible from their seed", () => {
  test("the same seed gives the same tree; another seed does not", () => {
    const a = makeRepo(7);
    const b = makeRepo(7);
    const c = makeRepo(8);
    try {
      assert.equal(treeDigest(a), treeDigest(b));
      assert.notEqual(treeDigest(a), treeDigest(c));
      assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: a, encoding: "utf8" }).trim().split("\n").length, 1);
    } finally {
      for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("H5.3: the fake model endpoint answers from its script and records each request", () => {
  test("a scripted answer is returned, and the request is recorded with its key header", async () => {
    const llm = await startFakeLlm(() => ({ status: 200, body: { ok: true } }));
    try {
      const r = await fetch(`${llm.url}/v1/messages`, { method: "POST", headers: { "x-api-key": "sk-fake-1", "content-type": "application/json" }, body: JSON.stringify({ model: "m1" }) });
      assert.equal(r.status, 200);
      assert.deepEqual(llm.requests, [{ path: "/v1/messages", method: "POST", model: "m1", authorization: undefined, xApiKey: "sk-fake-1" }]);
    } finally {
      await llm.close();
    }
  });
  test("by default it answers 401: there is no model behind it", async () => {
    const llm = await startFakeLlm();
    try {
      assert.equal((await fetch(`${llm.url}/v1/responses`, { method: "POST", body: "{}" })).status, 401);
    } finally {
      await llm.close();
    }
  });
});
