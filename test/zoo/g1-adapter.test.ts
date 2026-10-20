// G1 (design §17): handshake, read/read, read/edit, denied batch, release and rejoin
// against the REAL zoanthrope binary. Raw wire is written to evidence/g1-wire.jsonl.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ZooAdapter } from "../../src/zoo/adapter.ts";
import { type WireRecord, ZooError } from "../../src/zoo/types.ts";
import { openZoo, tempWorkspace, wp } from "../helpers.ts";

const wire: WireRecord[] = [];
const FILES = { "app/billing.py": "b\n", "app/schema.py": "s\n", "app/client.py": "c\n", "README.md": "r\n" };

describe("G1 adapter against the real binary", () => {
  let ws: string;
  let zoo: ZooAdapter;
  before(async () => {
    ws = tempWorkspace(FILES);
    zoo = await openZoo(ws, wire);
  });
  after(async () => {
    await zoo.close();
    mkdirSync("evidence", { recursive: true });
    writeFileSync("evidence/g1-wire.jsonl", wire.map((w) => JSON.stringify(w)).join("\n") + "\n");
  });

  test("handshake verified the pinned identity", () => {
    assert.equal(zoo.serverVersion, "0.1.6");
    assert.equal(zoo.identity?.version, "0.1.6");
    assert.match(zoo.identity?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  test("read/read co-hold; read/edit conflicts and names the holder", async () => {
    const r1 = await zoo.claim("g1-a", wp("README.md"), "read");
    const r2 = await zoo.claim("g1-b", wp("README.md"), "read");
    assert.equal(r1.kind, "granted");
    assert.equal(r2.kind, "granted");
    const e = await zoo.claim("g1-c", wp("README.md"), "edit");
    assert.equal(e.kind, "conflict");
    if (e.kind === "conflict") {
      assert.ok(["g1-a", "g1-b"].includes(e.conflict.holder));
      assert.equal(e.conflict.path, "README.md");
      assert.equal(e.conflict.holderStale, false);
    }
    await zoo.release("g1-a", wp("README.md"));
    await zoo.release("g1-b", wp("README.md"));
  });

  test("S01/S14: second editor gets ok=false as a Conflict, never a grant", async () => {
    const a = await zoo.claim("s01-a", wp("app/billing.py"), "edit", { purpose: "action-1" });
    assert.equal(a.kind, "granted");
    const b = await zoo.claim("s01-b", wp("app/billing.py"), "edit");
    assert.equal(b.kind, "conflict");
    if (b.kind === "conflict") {
      assert.equal(b.conflict.holder, "s01-a");
      assert.equal(b.conflict.purpose, "action-1");
      assert.equal((b.conflict.raw as { ok: boolean }).ok, false);
    }
    await zoo.release("s01-a", wp("app/billing.py"));
  });

  test("S02: batch with one held file is all-or-nothing; nothing partial stays", async () => {
    await zoo.claim("s02-b", wp("app/schema.py"), "edit");
    const a = await zoo.claim("s02-a", wp("app/client.py", "app/schema.py"), "edit");
    assert.equal(a.kind, "conflict");
    assert.deepEqual((await zoo.listClaims("s02-a")).map((c) => c.path), []);
    // client.py was not left locked by the failed batch
    const c = await zoo.claim("s02-c", wp("app/client.py"), "edit");
    assert.equal(c.kind, "granted");
    await zoo.release("s02-c", wp("app/client.py"));
    await zoo.release("s02-b", wp("app/schema.py"));
  });

  test("grants echo exactly the requested set, sorted, with intent and stamps", async () => {
    const r = await zoo.claim("g1-d", wp("app/schema.py", "app/billing.py"), "edit", {
      purpose: "action-9",
      stamps: [{ name: "digest:app/billing.py", value: "abc" }],
    });
    assert.equal(r.kind, "granted");
    if (r.kind === "granted") {
      assert.deepEqual(r.grants.map((g) => g.path), ["app/billing.py", "app/schema.py"]);
      assert.ok(r.grants.every((g) => g.intent === "edit"));
      assert.deepEqual(r.grants[0]?.callerStamps, [{ name: "digest:app/billing.py", value: "abc" }]);
    }
    await zoo.release("g1-d", wp("app/schema.py", "app/billing.py"));
  });

  test("release: registry cleared, filesystem cleanup never attested", async () => {
    await zoo.claim("g1-e", wp("app/billing.py", "app/schema.py"), "edit");
    const rel = await zoo.release("g1-e", wp("app/billing.py", "app/schema.py"));
    assert.deepEqual(rel.released, ["app/billing.py", "app/schema.py"]);
    assert.deepEqual(rel.stillHeld, []);
    assert.equal(rel.registryCleanup, "CLEARED");
    assert.equal(rel.fsCleanup, "NOT_ATTESTED");
    // and the file is claimable again by someone else
    const again = await zoo.claim("g1-f", wp("app/billing.py"), "edit");
    assert.equal(again.kind, "granted");
    await zoo.release("g1-f", wp("app/billing.py"));
  });

  test("rejoin reports kept claims and never breaks anyone's", async () => {
    await zoo.claim("g1-r", wp("app/billing.py"), "edit");
    const j = await zoo.rejoin("g1-r");
    assert.deepEqual(j.claimsKept, ["app/billing.py"]);
    assert.deepEqual(j.claimsAtRisk, []);
    assert.ok(j.viewEpoch > 0);
    const other = await zoo.claim("g1-s", wp("app/billing.py"), "edit");
    assert.equal(other.kind, "conflict");
    await zoo.release("g1-r", wp("app/billing.py"));
  });

  test("S14: isError=true from the engine is a ZooError(TOOL_ERROR), not a grant", async () => {
    await assert.rejects(
      // malformed stamp (no value) is rejected by the engine itself, not by the adapter
      zoo.claim("g1-err", wp("README.md"), "edit", { stamps: [{ name: "x" } as never] }),
      (e: unknown) => e instanceof ZooError && e.kind === "TOOL_ERROR",
    );
    assert.deepEqual(await zoo.listClaims("g1-err"), []);
  });

  test("local validation: blank agent id never reaches the engine", async () => {
    await assert.rejects(zoo.claim("", wp("README.md"), "edit"), /invalid agent id/);
  });
});

describe("S06 (engine level): a stale holder still blocks", () => {
  test("TTL=1s, wait past it, competitor is still refused with holder_stale=true", async () => {
    const ws = tempWorkspace({ "x.txt": "x" });
    const zoo = await openZoo(ws, undefined, { ZOANTHROPE_TTL_SECS: "1" });
    try {
      assert.equal((await zoo.claim("old", wp("x.txt"), "edit")).kind, "granted");
      await new Promise((r) => setTimeout(r, 2200));
      const c = await zoo.claim("new", wp("x.txt"), "edit");
      assert.equal(c.kind, "conflict");
      if (c.kind === "conflict") {
        assert.equal(c.conflict.holder, "old");
        assert.equal(c.conflict.holderStale, true);
      }
    } finally {
      await zoo.close();
    }
  });
});
