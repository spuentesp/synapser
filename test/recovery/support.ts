import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE } from "../executor/env.ts";

// Shared by the recovery tests: a real executor child process, killed at a failpoint, and a fresh workspace.
export const CHILD = new URL("../fixtures/executor-child.ts", import.meta.url).pathname;

export interface Died {
  signal: string | null;
  code: number | null;
  actionId: string | null;
  requestDigest: string | null;
  receipt: { status: string; state: string } | null;
}

export function runChild(state: string, ws: string, scenario: string, failpoint: string | null, extraEnv: NodeJS.ProcessEnv = {}): Promise<Died> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv } as NodeJS.ProcessEnv;
    delete env["SYNAPSER_FAILPOINT"];
    if (failpoint) {
      env["SYNAPSER_ENABLE_FAILPOINTS"] = "1";
      env["SYNAPSER_FAILPOINT"] = failpoint;
    }
    const p = spawn(process.execPath, [CHILD, state, ws, scenario], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code, signal) => {
      const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const proposed = lines.find((l) => l.event === "proposed");
      const receipt = lines.find((l) => l.event === "receipt");
      if (code && code !== 0 && !signal) return reject(new Error(`child failed: ${err.slice(0, 600)}`));
      resolve({
        signal,
        code,
        actionId: proposed?.actionId ?? null,
        requestDigest: proposed?.requestDigest ?? null,
        receipt: receipt ? { status: receipt.status, state: receipt.state } : null,
      });
    });
  });
}

export const fresh = () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "crash-ws-")));
  cpSync(BASELINE, ws, { recursive: true });
  const state = realpathSync(mkdtempSync(join(tmpdir(), "crash-state-")));
  return { ws, state };
};

export const BILLING_AFTER = '"""billing v2"""\n';
