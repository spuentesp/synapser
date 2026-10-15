// Plan 18 E5 (H5.1, H5.5): a throwaway repository that looks like a small project: sources, tests, a manifest and a git
// history. The same seed always yields the same tree, byte for byte, so a failing run can be reproduced.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** A small deterministic generator (mulberry32). Not for security; for reproducible fixtures. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRepo(seed: number, modules = 3): string {
  const next = rng(seed);
  const dir = mkdtempSync(join(tmpdir(), `fixture-repo-${seed}-`));
  const names = Array.from({ length: modules }, (_, i) => `mod${i}_${Math.floor(next() * 1000)}`);
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `fixture-${seed}`, version: "0.0.1", type: "module" }, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), `# fixture ${seed}\n`);
  names.forEach((name, i) => {
    const value = Math.floor(next() * 100);
    writeFileSync(join(dir, "app", `${name}.js`), `export const ${name} = (x) => x + ${value};\n`);
    writeFileSync(join(dir, "tests", `${name}.test.js`), `import { ${name} } from "../app/${name}.js";\nimport assert from "node:assert/strict";\nassert.equal(${name}(1), ${1 + value});\n`);
    if (i === 0) writeFileSync(join(dir, "app", "index.js"), `export * from "./${name}.js";\n`);
  });
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  return dir;
}

/** A digest of every file under the tree, excluding git metadata: the identity of the tree's content. */
export function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0${readFileSync(p).toString("base64")}\0`);
    }
  };
  walk(dir);
  return h.digest("hex");
}
