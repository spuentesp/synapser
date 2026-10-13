// Startup recovery (plan 04). Disk is the truth about CONTENT, the journal about INTENT, Zoanthrope
// about WHO HOLDS WHAT. Phase A only reads; phase B acts, per action; phase C reconciles the registry.
// Rules that never bend: roll FORWARD only; never touch a claim that is not ours; never overwrite
// content we did not predict; uncertainty is kept as RECOVERY_REQUIRED with the bytes preserved.

import { ABSENT, type Digest, MAX_ACTION_FILE_BYTES, observeFile } from "../digest/file.ts";
import type { ActionFileRow, ActionRow, Journal } from "../journal/journal.ts";
import type { WorkspacePath } from "../workspace/paths.ts";
import { ZooError } from "../zoo/types.ts";
import { readFileSync, unlinkSync } from "node:fs";
import { absPath } from "./fs-applier.ts";
import type { Executor, ZooPort } from "./executor.ts";

export type FileClass = "BEFORE" | "AFTER" | "OTHER";

export interface ActionDecision {
  actionId: string;
  from: string;
  to: string;
  decision: string;
  detail?: unknown;
}

export interface RecoveryReport {
  degraded: boolean;
  decisions: ActionDecision[];
  orphanClaimsReleased: { agent: string; path: string }[];
  claimsAtRisk: { agent: string; paths: string[] }[];
  tempsRemoved: string[];
  sessionsBumped: string[];
}

export interface RecoveryDeps {
  executor: Executor;
  journal: Journal;
  zoo: ZooPort;
  workspaceRoot: string;
  runId: string;
  generation: number;
  model?: string;
}

/** Classify what is on disk for one file against what the journal predicted. */
export function classify(root: string, f: ActionFileRow): { cls: FileClass; observed: Digest | "absent" | "other" } {
  const o = observeFile(absPath(root, f.path));
  if (o.kind === "other") return { cls: "OTHER", observed: "other" };
  const seen = o.kind === "absent" ? ABSENT : o.digest;
  const before = f.beforeDigest ?? ABSENT;
  const after = f.afterDigest ?? ABSENT;
  // before == after is a no-op edit: it counts as AFTER
  if (seen === after) return { cls: "AFTER", observed: seen };
  if (seen === before) return { cls: "BEFORE", observed: seen };
  return { cls: "OTHER", observed: seen };
}

export async function recoverRun(d: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    degraded: false,
    decisions: [],
    orphanClaimsReleased: [],
    claimsAtRisk: [],
    tempsRemoved: [],
    sessionsBumped: [],
  };
  const { journal, zoo, runId } = d;
  const root = d.workspaceRoot;

  // ---- Phase 0: the old incarnation stops being valid before anything else happens ----------
  for (const s of journal.listSessions()) {
    if (s.generation < d.generation) {
      journal.tx((t) => t.upsertSession(runId, s.actorOwner, d.generation, d.model ?? "unspecified", true));
      report.sessionsBumped.push(s.actorOwner);
    }
  }

  // ---- Phase A: read-only ------------------------------------------------------------------
  const actions = journal.listNonTerminal();
  const snapshot = actions.map((a) => ({
    a,
    files: journal.getActionFiles(a.actionId),
  }));
  try {
    await zoo.listClaims();
  } catch (e) {
    if (!(e instanceof ZooError)) throw e;
    // Coordination is down: classify and report, but do not act (S09). Nothing is written.
    report.degraded = true;
    for (const { a, files } of snapshot) {
      report.decisions.push({
        actionId: a.actionId,
        from: a.state,
        to: a.state,
        decision: "DEFERRED_COORDINATION_UNAVAILABLE",
        detail: files.map((f) => ({ path: f.path, ...classify(root, f) })),
      });
    }
    journal.tx((t) => t.event(runId, "recovery", "run", null, "DEGRADED", { reason: e.kind }));
    return report;
  }

  // ---- Phase B: act, oldest action first ---------------------------------------------------
  for (const { a, files } of snapshot) {
    const dec = await decide(d, a, files);
    report.decisions.push(dec);
  }

  // temp files: exact names recorded at PREPARE, removed only after classification
  for (const { a, files } of snapshot) {
    for (const f of files) {
      if (!f.tmpName) continue;
      const dir = absPath(root, f.path).slice(0, absPath(root, f.path).lastIndexOf("/"));
      const tmp = `${dir}/${f.tmpName}`;
      try {
        unlinkSync(tmp);
        report.tempsRemoved.push(tmp.slice(root.length + 1));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    void a;
  }

  // ---- Phase C: registry reconciliation ----------------------------------------------------
  try {
    // PREPARED and WAITING_RESOURCE never hold claims: they explain nothing in the registry.
    const live = journal.listNonTerminal().filter((a) => a.state !== "PREPARED" && a.state !== "WAITING_RESOURCE");
    const covered = new Map<string, Set<string>>(); // actor -> paths of live actions
    for (const a of live) {
      const set = covered.get(a.actorOwner) ?? new Set<string>();
      for (const f of journal.getActionFiles(a.actionId)) set.add(f.path);
      covered.set(a.actorOwner, set);
    }
    const prefix = `${runId}:`;
    for (const c of await zoo.listClaims()) {
      if (!c.agent.startsWith(prefix)) continue; // never touch a claim that is not ours
      const isReader = c.agent.endsWith("#r");
      const owned = !isReader && covered.get(c.agent)?.has(c.path);
      if (owned) continue;
      // Orphan of a dead incarnation of OUR executor: released through the normal API, after
      // the previous executor is provably gone (we hold the workspace lock) and actions are settled.
      const r = await zoo.release(c.agent, [c.path as WorkspacePath]);
      if (r.released.includes(c.path)) {
        report.orphanClaimsReleased.push({ agent: c.agent, path: c.path });
      }
    }
    for (const actor of covered.keys()) {
      const rj = await zoo.rejoin(actor);
      if (rj.claimsAtRisk.length) report.claimsAtRisk.push({ agent: actor, paths: rj.claimsAtRisk });
    }
  } catch (e) {
    if (!(e instanceof ZooError)) throw e;
    report.degraded = true;
  }

  journal.tx((t) => t.event(runId, "recovery", "run", null, "REPORT", report));
  if (!report.degraded) d.executor.markRecovered();
  return report;
}

// ----------------------------------------------------------------------------------------------

async function decide(d: RecoveryDeps, a: ActionRow, files: ActionFileRow[]): Promise<ActionDecision> {
  const { journal, zoo, executor } = d;
  const paths = files.map((f) => f.path as WorkspacePath);
  const done = (to: string, decision: string, detail?: unknown): ActionDecision => ({
    actionId: a.actionId,
    from: a.state,
    to,
    decision,
    ...(detail === undefined ? {} : { detail }),
  });
  const now = () => journal.getAction(a.actionId)?.state ?? a.state;

  const cls = files.map((f) => ({ f, ...classify(d.workspaceRoot, f) }));
  const anyOther = cls.some((c) => c.cls === "OTHER");
  const allAfter = cls.every((c) => c.cls === "AFTER");

  const keepEvidence = () => {
    // Preserve what is actually on disk; never overwrite it.
    const evidence: { path: string; observed: string; blob: string | null }[] = [];
    for (const c of cls.filter((x) => x.cls === "OTHER")) {
      let blob: string | null = null;
      const o = observeFile(absPath(d.workspaceRoot, c.f.path));
      if (o.kind === "file" && o.size <= MAX_ACTION_FILE_BYTES) {
        blob = journal.artifacts.put(readFileSync(absPath(d.workspaceRoot, c.f.path)));
      }
      evidence.push({ path: c.f.path, observed: c.observed, blob });
    }
    return evidence;
  };
  const toRecoveryRequired = (code: string, detail: Record<string, unknown> = {}) => {
    const from = journal.getAction(a.actionId)?.state as ActionRow["state"];
    journal.tx((t) => t.transition(a.runId, a.actionId, from, "RECOVERY_REQUIRED", { errorCode: code, event: detail }));
    return done("RECOVERY_REQUIRED", code, detail);
  };

  try {
    switch (a.state) {
      case "PREPARED":
      case "WAITING_RESOURCE":
        return done(a.state, "UNTOUCHED");

      case "CLAIMING": {
        const held = (await zoo.listClaims(a.actorOwner)).filter((c) => paths.includes(c.path as WorkspacePath));
        if (held.length === 0) {
          journal.tx((t) => t.transition(a.runId, a.actionId, "CLAIMING", "WAITING_RESOURCE", { errorCode: "RESTART" }));
          return done("WAITING_RESOURCE", "CLAIMING_NO_CLAIMS_RETRY");
        }
        if (held.length === paths.length) {
          journal.tx((t) => t.transition(a.runId, a.actionId, "CLAIMING", "CLAIMED"));
          await executor.resumeFromClaimed(a.actionId);
          return done(now(), "CLAIMING_FULL_SET_CONTINUED");
        }
        await zoo.release(a.actorOwner, held.map((c) => c.path as WorkspacePath));
        journal.tx((t) => t.transition(a.runId, a.actionId, "CLAIMING", "WAITING_RESOURCE", { errorCode: "RESTART" }));
        return done("WAITING_RESOURCE", "CLAIMING_PARTIAL_RELEASED", { released: held.map((c) => c.path) });
      }

      case "CLAIMED": {
        const claim = await zoo.claim(a.actorOwner, paths, "edit", { purpose: `recovery ${a.actionId}` });
        if (claim.kind === "conflict") {
          journal.tx((t) =>
            t.transition(a.runId, a.actionId, "CLAIMED", "WAITING_RESOURCE", {
              errorCode: "RESOURCE_BUSY",
              event: { holder: claim.conflict.holder, path: claim.conflict.path },
            }),
          );
          return done("WAITING_RESOURCE", "CLAIMED_CLAIM_LOST_RETRY");
        }
        await executor.resumeFromClaimed(a.actionId);
        return done(now(), "CLAIMED_CONTINUED");
      }

      case "STALE_VIEW":
        await executor.resumeRelease(a.actionId, "STALE_VIEW");
        return done(now(), "STALE_VIEW_RELEASED");

      case "APPLIED":
        if (anyOther) return toRecoveryRequired("OBSERVED_FOREIGN_CONTENT", { evidence: keepEvidence() });
        await executor.resumeRelease(a.actionId, "APPLIED");
        return done(now(), "APPLIED_RELEASED");

      case "RELEASE_PENDING":
        if (anyOther) return toRecoveryRequired("OBSERVED_FOREIGN_CONTENT", { evidence: keepEvidence() });
        await executor.resumeReleasePending(a.actionId);
        return done(now(), "RELEASE_COMPLETED");

      case "EXECUTING":
      case "RECOVERY_REQUIRED": {
        if (anyOther) {
          if (a.state === "RECOVERY_REQUIRED") return done("RECOVERY_REQUIRED", "STILL_FOREIGN_CONTENT", { evidence: keepEvidence() });
          return toRecoveryRequired("OBSERVED_FOREIGN_CONTENT", { evidence: keepEvidence() });
        }
        if (allAfter) {
          // Everything landed; only the confirmation was lost. Never re-apply, never call the model.
          const receipt = { applied_files: files.map((f) => ({ path: f.path, digest: f.afterDigest ?? ABSENT })) };
          for (const c of cls) {
            if (c.f.progress === "PENDING") {
              journal.tx((t) => t.markFileApplied(a.runId, a.actionId, c.f.path, c.f.afterDigest));
            }
          }
          journal.tx((t) => t.transition(a.runId, a.actionId, a.state, "APPLIED", { receipt, event: { recovered: true } }));
          await executor.resumeRelease(a.actionId, "APPLIED");
          return done(now(), "ALL_AFTER_CONFIRMED");
        }
        // BEFORE/AFTER mix (or all BEFORE): finish ONLY the recorded steps, under re-acquired claims.
        const claim = await zoo.claim(a.actorOwner, paths, "edit", { purpose: `recovery ${a.actionId}` });
        if (claim.kind === "conflict") {
          if (a.state === "EXECUTING") {
            return toRecoveryRequired("RESUME_BLOCKED", { holder: claim.conflict.holder, path: claim.conflict.path });
          }
          return done("RECOVERY_REQUIRED", "RESUME_BLOCKED", { holder: claim.conflict.holder, path: claim.conflict.path });
        }
        // A granted claim does not validate content: look again NOW, with the claim held.
        const again = files.map((f) => ({ f, ...classify(d.workspaceRoot, f) }));
        if (again.some((c) => c.cls === "OTHER")) {
          cls.splice(0, cls.length, ...again);
          if (a.state === "RECOVERY_REQUIRED") return done("RECOVERY_REQUIRED", "FOREIGN_CONTENT_AFTER_CLAIM", { evidence: keepEvidence() });
          return toRecoveryRequired("OBSERVED_FOREIGN_CONTENT", { evidence: keepEvidence(), after_claim: true });
        }
        if (a.state === "RECOVERY_REQUIRED") {
          journal.tx((t) => t.transition(a.runId, a.actionId, "RECOVERY_REQUIRED", "EXECUTING", { errorCode: null }));
        }
        await executor.resumeExecuting(a.actionId);
        return done(now(), "ROLLED_FORWARD", { classes: cls.map((c) => [c.f.path, c.cls]) });
      }

      default:
        return done(a.state, "NO_ACTION");
    }
  } catch (e) {
    if (e instanceof ZooError) return done(now(), "DEFERRED_COORDINATION_UNAVAILABLE", { kind: e.kind });
    throw e;
  }
}
