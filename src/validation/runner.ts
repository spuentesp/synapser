// ValidationPort + LocalRunner (plan 06 §9). Commands come from a REVIEWED allowlist chosen by the
// mission, never by a model. They run on a COPY of the workspace, with a minimal environment, in
// their own process group (so a dead executor's children can be reaped), and without a network
// when the host allows it. The result is valid only for the snapshot digest it was computed on.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "../journal/journal.ts";
import { procStartTicks } from "../recovery/children.ts";
import { type Snapshot, takeSnapshot, treeDigest } from "./snapshot.ts";

export interface AllowedCommand {
  id: string;
  argv: readonly string[];
  /** Extra environment entries (e.g. PYTHONPATH). PATH and a scratch HOME are always provided. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface ValidationResult {
  validationId: string;
  commandId: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  snapshotDigest: string;
  /** False when the tree changed while the command ran, or the snapshot was inconsistent. */
  valid: boolean;
  passed: boolean;
  networkIsolated: boolean;
  runner: "local";
  stdout: string;
  stderr: string;
  outputBlob: string;
  note: string | null;
}

export interface ValidationPort {
  run(commandId: string, ctx: { taskId: string }): Promise<ValidationResult>;
}

const MAX_OUTPUT = 1024 * 1024;

let netIsolationSupported: boolean | null = null;
/** `unshare -rn` gives the child a private network namespace with only loopback. */
export function canIsolateNetwork(): boolean {
  if (netIsolationSupported === null) {
    const r = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore", timeout: 3000 });
    netIsolationSupported = r.status === 0;
  }
  return netIsolationSupported;
}

export interface LocalRunnerDeps {
  journal: Journal;
  runId: string;
  workspaceRoot: string;
  commands: readonly AllowedCommand[];
  generation: number;
  /** Refuse to isolate-less run when true (default false: reported in the evidence instead). */
  requireNetworkIsolation?: boolean;
  /** Called just before the command starts, after the snapshot is taken (used by tests for S11/S18). */
  onSnapshot?: (s: Snapshot) => void | Promise<void>;
}

export class LocalRunner implements ValidationPort {
  readonly #d: LocalRunnerDeps;
  constructor(deps: LocalRunnerDeps) {
    this.#d = deps;
  }

  async run(commandId: string, ctx: { taskId: string }): Promise<ValidationResult> {
    const cmd = this.#d.commands.find((c) => c.id === commandId);
    if (!cmd) throw new Error(`command ${JSON.stringify(commandId)} is not in the allowlist`);
    const isolated = canIsolateNetwork();
    if (this.#d.requireNetworkIsolation && !isolated) throw new Error("network isolation required but unavailable on this host");

    const scratch = mkdtempSync(join(tmpdir(), "synapser-val-"));
    const snapDir = join(scratch, "snapshot");
    const home = join(scratch, "home");
    mkdirSync(snapDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const validationId = `val-${randomUUID()}`;
    try {
      const snap = takeSnapshot(this.#d.workspaceRoot, snapDir);
      await this.#d.onSnapshot?.(snap);
      this.#d.journal.tx((t) =>
        t.insertValidation({ validationId, runId: this.#d.runId, taskId: ctx.taskId, command: cmd.id, snapshotDigest: snap.digest, scopeDigest: snap.digest }),
      );

      let registeredPid: number | null = null;
      const argv = isolated ? ["unshare", "-rn", "--", ...cmd.argv] : [...cmd.argv];
      const started = Date.now();
      const out = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(argv[0] as string, argv.slice(1), {
          cwd: snapDir,
          detached: true, // own process group
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: home,
            PYTHONDONTWRITEBYTECODE: "1",
            LANG: "C.UTF-8",
            ...(cmd.env ?? {}),
          },
        });
        const pid = child.pid as number;
        const ticks = procStartTicks(pid);
        if (ticks !== null) {
          registeredPid = pid;
          this.#d.journal.tx((t) => t.registerChild({ pid, kind: "validation", runId: this.#d.runId, taskId: ctx.taskId, procStartTicks: ticks, pgid: pid, generation: this.#d.generation }));
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const cap = (cur: string, d: Buffer) => (cur.length >= MAX_OUTPUT ? cur : cur + d.toString("utf8").slice(0, MAX_OUTPUT - cur.length));
        child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
        child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, cmd.timeoutMs ?? 60_000);
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ code: null, timedOut, stdout, stderr: `${stderr}\n[spawn error: ${e.message}]` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          try {
            process.kill(-pid, "SIGKILL"); // nothing from the group may outlive the command
          } catch {
            /* none left */
          }
          resolve({ code, timedOut, stdout, stderr });
        });
      });
      if (registeredPid !== null) {
        const pid = registeredPid;
        this.#d.journal.tx((t) => t.removeChild(pid));
      }

      // S11/S18: the result only counts if the live tree is still exactly what we tested
      const liveAfter = treeDigest(this.#d.workspaceRoot);
      const changed = liveAfter !== snap.digest;
      const valid = snap.consistent && !changed;
      const note = !snap.consistent ? "snapshot was not consistent (a write raced the copy)" : changed ? "workspace changed while the command ran" : null;
      const outputBlob = this.#d.journal.artifacts.put(Buffer.from(JSON.stringify({ stdout: out.stdout, stderr: out.stderr, argv, code: out.code })));
      this.#d.journal.tx((t) => t.finishValidation(validationId, this.#d.runId, { exitCode: out.code, outputBlob, valid, ...(note ? { note } : {}) }));
      return {
        validationId,
        commandId: cmd.id,
        exitCode: out.code,
        timedOut: out.timedOut,
        durationMs: Date.now() - started,
        snapshotDigest: snap.digest,
        valid,
        passed: valid && out.code === 0 && !out.timedOut,
        networkIsolated: isolated,
        runner: "local",
        stdout: out.stdout,
        stderr: out.stderr,
        outputBlob,
        note,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
