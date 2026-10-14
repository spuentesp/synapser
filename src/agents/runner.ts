// AgentRunner (cli-oneshot adapter). The CLI never touches the real workspace: it runs in an
// isolated COPY, and what it produced is taken back as a set of file changes that must pass
// through the patch broker (src/agents/broker.ts) and the executor like any other writer.
// Everything observable about the run is recorded in the journal as one `agent_runs` row.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Digest, MAX_ACTION_FILE_BYTES, observeFile } from "../digest/file.ts";
import type { Journal } from "../journal/journal.ts";
import { procStartTicks } from "../recovery/children.ts";
import { listTree, takeSnapshot, treeEntries } from "../validation/snapshot.ts";
import { NO_INJECTED_SKILLS, PROFILE_CLI_ADAPTER, type AgentAdapter, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { type KimiOptions, type Outcome, type ParsedRun, type UsageRecord } from "./usage.ts";

export { buildAgentEnv, CREDENTIAL_ENV_DENY, GIT_HARDENING } from "./adapter.ts";

export interface FileChange {
  path: string;
  op: "create" | "modify" | "delete";
  beforeDigest: Digest | null;
  afterDigest: Digest | null;
  beforeBlob: string | null;
  afterBlob: string | null;
  mode: number | null;
  /** Not valid UTF-8 or over the action size limit: cannot be integrated in the MVP. */
  unsupported: "BINARY" | "TOO_LARGE" | null;
}

export interface AgentRunResult {
  agentRunId: string;
  profileId: string;
  role: string;
  outcome: Outcome;
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  usage: UsageRecord;
  toolUse: Record<string, number> | null;
  sessionId: string | null;
  finalText: string | null;
  baseDigest: Digest;
  baseConsistent: boolean;
  changes: FileChange[];
  stdoutBlob: string;
  stderrBlob: string;
  networkIsolated: false;
}

/** Directories the CLIs create for their own bookkeeping: not part of the user's change. */
export const AGENT_METADATA = new Set([".claude", ".codex", ".kimi", ".kimi-code", ".mimo", ".mimocode", ".opencode", ".cursor", ".gemini", ".aider.tags.cache.v3"]);

const MAX_OUT = 4 * 1024 * 1024;

/** Link ONLY the tool's own settings into a scratch HOME. Returns the scratch HOME path. */
export function makeScratchHome(scratch: string, profile: AgentProfile, realHome: string | undefined): string {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  for (const rel of profile.homeOverlay ?? []) {
    if (!realHome || rel.startsWith("/") || rel.includes("..")) continue;
    const src = join(realHome, rel);
    if (!existsSync(src)) continue;
    const dst = join(home, rel);
    mkdirSync(join(dst, ".."), { recursive: true });
    try {
      symlinkSync(src, dst);
    } catch {
      /* already linked */
    }
  }
  return home;
}

export interface RunAgentOptions {
  profile: AgentProfile;
  prompt: string;
  workspaceRoot: string;
  runId: string;
  taskId: string | null;
  journal: Journal;
  generation: number;
  /** Invocation/parser implementation. Direct callers retain the legacy profile-driven default. */
  adapter?: AgentAdapter;
  injectedSkills?: InjectedSkills;
  kimi?: KimiOptions;
  /** Replaces the process environment as the source for the allowlist (tests). */
  envSource?: NodeJS.ProcessEnv;
}

export async function runAgent(o: RunAgentOptions): Promise<AgentRunResult> {
  const { profile, journal } = o;
  const adapter = o.adapter ?? PROFILE_CLI_ADAPTER;
  if (!profile.enabled) throw new Error(`profile ${profile.id} is disabled: ${profile.disabledReason ?? "no reason recorded"}`);
  const agentRunId = `ar-${randomUUID()}`;
  const scratch = mkdtempSync(join(tmpdir(), "synapser-agent-"));
  const baseDir = join(scratch, "base"); // what the agent was GIVEN: never touched afterwards
  const work = join(scratch, "work"); //     what the agent edits
  mkdirSync(baseDir, { recursive: true });
  const startedAt = Date.now();
  try {
    const snap = takeSnapshot(o.workspaceRoot, baseDir);
    cpSync(baseDir, work, { recursive: true });
    const base = new Map(treeEntries(baseDir, snap.files).map((e) => [e.path, e]));
    const promptBlob = journal.artifacts.put(Buffer.from(o.prompt, "utf8"));
    const home = makeScratchHome(scratch, profile, (o.envSource ?? process.env)["HOME"]);
    const invocation = adapter.build(
      profile,
      { prompt: o.prompt, cwd: work, home, envSource: o.envSource ?? process.env },
      o.injectedSkills ?? NO_INJECTED_SKILLS,
    );
    if (invocation.files.length > 0) throw new Error(`adapter ${adapter.id} returned files before skill injection is enabled`);
    const argv = [...invocation.argv];
    const template = [...invocation.argvTemplate];

    const exec = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; spawnError: string | null }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let child;
      try {
        child = spawn(argv[0] as string, argv.slice(1), { cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"], env: invocation.env });
      } catch (e) {
        return resolve({ code: null, signal: null, timedOut: false, stdout, stderr, spawnError: String((e as Error).message) });
      }
      const pid = child.pid;
      let registered = false;
      if (pid !== undefined) {
        const ticks = procStartTicks(pid);
        if (ticks !== null) {
          journal.tx((t) => t.registerChild({ pid, kind: "agent", runId: o.runId, taskId: o.taskId, procStartTicks: ticks, pgid: pid, generation: o.generation }));
          registered = true;
        }
      }
      const cap = (cur: string, d: Buffer) => (cur.length >= MAX_OUT ? cur : cur + d.toString("utf8").slice(0, MAX_OUT - cur.length));
      child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
      child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (pid !== undefined) process.kill(-pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, profile.timeoutMs);
      const finish = (code: number | null, signal: string | null, spawnError: string | null) => {
        clearTimeout(timer);
        try {
          if (pid !== undefined) process.kill(-pid, "SIGKILL"); // nothing from the group outlives the run
        } catch {
          /* none left */
        }
        if (registered && pid !== undefined) journal.tx((t) => t.removeChild(pid));
        resolve({ code, signal, timedOut, stdout, stderr, spawnError });
      };
      child.on("error", (e) => finish(null, null, e.message));
      child.on("close", (code, signal) => finish(code, signal, null));
    });

    // Interpret the tool's OWN events; the exit code alone is not evidence of success.
    let parsed: ParsedRun;
    if (exec.spawnError) {
      parsed = { outcome: "FAILED", reason: `spawn failed: ${exec.spawnError}`, finalText: null, sessionId: null, permissionDenials: null, toolUse: null, usage: { provenance: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null, models: [], turns: null, apiMs: null, note: "did not start" } };
    } else {
      parsed = adapter.parse(exec.stdout, profile, { ...(o.kimi ? { kimi: o.kimi } : {}) });
      if (exec.timedOut) parsed = { ...parsed, outcome: "FAILED", reason: `timed out after ${profile.timeoutMs} ms` };
      else if (parsed.outcome === "SUCCEEDED" && exec.code !== 0) parsed = { ...parsed, outcome: "FAILED", reason: `exit code ${String(exec.code)} despite a success event` };
      else if (parsed.outcome === "UNKNOWN" && exec.code !== 0) {
        // no success evidence AND the process failed: that is a failure, with the tool's own message
        const msg = exec.stderr.trim().split("\n").filter(Boolean)[0] ?? exec.stdout.trim().split("\n")[0] ?? "";
        parsed = { ...parsed, outcome: "FAILED", reason: `exit code ${String(exec.code)}${msg ? `: ${msg.slice(0, 200)}` : ""}` };
      }
    }

    // What changed in the copy, with the bytes needed to integrate it later.
    const changes: FileChange[] = [];
    const after = new Map<string, string>();
    for (const f of listTree(work)) {
      if (f.split("/").some((seg) => AGENT_METADATA.has(seg))) continue;
      after.set(f, f);
    }
    const seen = new Set<string>();
    for (const f of after.keys()) {
      seen.add(f);
      const o2 = observeFile(join(work, f));
      if (o2.kind !== "file") continue;
      const b = base.get(f);
      if (b && b.digest === o2.digest) continue;
      changes.push(toChange(work, baseDir, f, b ? "modify" : "create", b?.digest ?? null, o2.digest, o2.mode, o2.size, journal));
    }
    for (const [p2, b] of base) {
      if (seen.has(p2) || p2.split("/").some((seg) => AGENT_METADATA.has(seg))) continue;
      changes.push(toChange(work, baseDir, p2, "delete", b.digest, null, null, 0, journal));
    }
    changes.sort((x, y) => (x.path < y.path ? -1 : 1));

    const durationMs = Date.now() - startedAt;
    const stdoutBlob = journal.artifacts.put(Buffer.from(exec.stdout, "utf8"));
    const stderrBlob = journal.artifacts.put(Buffer.from(exec.stderr, "utf8"));
    const finalTextBlob = parsed.finalText === null ? null : journal.artifacts.put(Buffer.from(parsed.finalText, "utf8"));
    journal.tx((t) =>
      t.insertAgentRun({
        agentRunId, runId: o.runId, taskId: o.taskId, profileId: profile.id, role: profile.role, adapter: adapter.id,
        startedAt, finishedAt: Date.now(), durationMs, argv: template, baseDigest: snap.digest,
        exitCode: exec.code, signal: exec.signal, timedOut: exec.timedOut, outcome: parsed.outcome, reason: parsed.reason,
        sessionId: parsed.sessionId, models: parsed.usage.models, usageProvenance: parsed.usage.provenance,
        inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens, cacheReadTokens: parsed.usage.cacheReadTokens,
        cacheWriteTokens: parsed.usage.cacheWriteTokens, reasoningTokens: parsed.usage.reasoningTokens, costUsd: parsed.usage.costUsd,
        turns: parsed.usage.turns, apiMs: parsed.usage.apiMs, networkIsolated: false, permissionDenials: parsed.permissionDenials,
        promptBlob, stdoutBlob, stderrBlob, finalTextBlob, toolUse: parsed.toolUse,
        changes: changes.map((c) => ({ path: c.path, op: c.op, beforeDigest: c.beforeDigest, afterDigest: c.afterDigest })),
      }),
    );
    return {
      agentRunId, profileId: profile.id, role: profile.role, outcome: parsed.outcome, reason: parsed.reason,
      exitCode: exec.code, signal: exec.signal, timedOut: exec.timedOut, durationMs, usage: parsed.usage, toolUse: parsed.toolUse,
      sessionId: parsed.sessionId, finalText: parsed.finalText, baseDigest: snap.digest, baseConsistent: snap.consistent,
      changes, stdoutBlob, stderrBlob, networkIsolated: false,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function toChange(
  work: string,
  baseDir: string,
  path: string,
  op: FileChange["op"],
  before: Digest | null,
  after: Digest | null,
  mode: number | null,
  size: number,
  journal: Journal,
): FileChange {
  let unsupported: FileChange["unsupported"] = null;
  let afterBlob: string | null = null;
  let beforeBlob: string | null = null;
  if (op !== "delete") {
    const bytes = readFileSync(join(work, path));
    if (size > MAX_ACTION_FILE_BYTES) unsupported = "TOO_LARGE";
    else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        unsupported = "BINARY";
      }
    }
    if (!unsupported) afterBlob = journal.artifacts.put(bytes);
  }
  if (op !== "create") {
    // The BASE content, from the pristine copy the agent was handed. Reading it from the live tree
    // here would pick up edits made DURING the run and hide them from the staleness check.
    beforeBlob = journal.artifacts.put(readFileSync(join(baseDir, path)));
  }
  return { path, op, beforeDigest: before, afterDigest: after, beforeBlob, afterBlob, mode, unsupported };
}
