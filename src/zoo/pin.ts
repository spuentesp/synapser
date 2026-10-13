import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { execFileSync } from "node:child_process";
import type { ZooPin } from "./adapter.ts";

interface LockFile {
  version: string;
  commit: string;
  sha256: Record<string, string>;
}

export function platformKey(): string {
  const a = arch() === "x64" ? "x86_64" : arch();
  return `${platform()}-${a}`;
}

/** Read zoanthrope.lock.json and resolve the binary from ZOANTHROPE_BIN or PATH. */
export function loadPin(lockPath = new URL("../../zoanthrope.lock.json", import.meta.url)): ZooPin & { commit: string } {
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
  let binary = process.env["ZOANTHROPE_BIN"];
  if (!binary) {
    try {
      binary = execFileSync("which", ["zoanthrope"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("set ZOANTHROPE_BIN to the pinned zoanthrope binary (see zoanthrope.lock.json)");
    }
  }
  const sha256 = lock.sha256[platformKey()];
  return { binary, version: lock.version, commit: lock.commit, ...(sha256 ? { sha256 } : {}) };
}
