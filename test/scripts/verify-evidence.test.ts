import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { resolveEvidenceRoot, resolveExternalDirectory } from "../../scripts/evidence-path.ts";

describe("verification evidence destination", () => {
  const scratch = mkdtempSync(join(tmpdir(), "synapser-evidence-test-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("defaults to the ignored evidence directory", () => {
    assert.equal(resolveEvidenceRoot("/workspace/synapser", undefined), "/workspace/synapser/evidence");
  });

  test("accepts an explicit absolute destination outside the repository", () => {
    const root = join(scratch, "repo");
    const external = join(scratch, "evidence");
    mkdirSync(root, { recursive: true });
    assert.equal(resolveEvidenceRoot(root, external), external);
  });

  test("rejects relative and repository-local destinations", () => {
    const root = join(scratch, "repo");
    mkdirSync(root, { recursive: true });
    assert.throws(() => resolveEvidenceRoot(root, "evidence-outside"), /absolute path/);
    assert.throws(() => resolveEvidenceRoot(root, join(root, "evidence")), /outside the repository/);
  });

  test("rejects symlinks that redirect an external-looking destination into the repository", () => {
    const root = join(scratch, "repo");
    const alias = join(scratch, "evidence-alias");
    mkdirSync(root, { recursive: true });
    symlinkSync(root, alias, "dir");
    assert.throws(() => resolveExternalDirectory(root, alias, "evidence"), /symlinks/);
  });
});
