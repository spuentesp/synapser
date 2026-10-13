// Plan 04 §8. Run after every recovery in every crash test: a violation is a bug even if the
// scenario's own assertions pass.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ABSENT, comparable, observeFile } from "../../src/digest/file.ts";
import type { Env } from "./env.ts";
import { RUN } from "./env.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".zoanthrope") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export async function checkInvariants(env: Env, opts: { expectNoClaims?: boolean } = {}): Promise<string[]> {
  const v: string[] = [];
  const j = env.journal;
  const events = j.listEvents();

  // I6 contiguous sequence
  events.forEach((e, i) => {
    if (e.seq !== i + 1) v.push(`I6: event seq ${e.seq} at position ${i + 1}`);
  });

  // I4 each action reached APPLIED at most once
  const applied = new Map<string, number>();
  for (const e of events) {
    if (e.entity === "action" && e.toState === "APPLIED") applied.set(e.entityId, (applied.get(e.entityId) ?? 0) + 1);
  }
  for (const [id, n] of applied) if (n > 1) v.push(`I4: action ${id} reached APPLIED ${n} times`);

  // I1 applied results are on disk (single-writer fixtures: no later action supersedes)
  const all = events.filter((e) => e.entity === "action" && e.fromState === null).map((e) => e.entityId);
  const lastWriter = new Map<string, string>();
  for (const id of all) {
    const a = j.getAction(id);
    if (!a || a.errorCode === "STALE_VIEW") continue;
    if (["APPLIED", "RELEASE_PENDING", "SETTLED"].includes(a.state)) {
      for (const f of j.getActionFiles(id)) lastWriter.set(f.path, id);
    }
  }
  for (const [path, id] of lastWriter) {
    const f = j.getActionFiles(id).find((x) => x.path === path)!;
    const seen = comparable(observeFile(join(env.ws, path)));
    const want = f.afterDigest ?? ABSENT;
    if (seen !== want) v.push(`I1: ${path} is ${seen} but action ${id} applied ${want}`);
  }

  // I5 no temp files once nothing is mid-flight
  if (j.listNonTerminal().every((a) => a.state === "PREPARED" || a.state === "WAITING_RESOURCE")) {
    for (const p of walk(env.ws)) if (p.includes(".synapser-tmp-")) v.push(`I5: leftover temp ${p}`);
  }

  // I3 registry holds nothing of ours that no live action explains
  const live = j.listNonTerminal().filter((a) => a.state !== "PREPARED" && a.state !== "WAITING_RESOURCE");
  const explained = new Set<string>();
  for (const a of live) for (const f of j.getActionFiles(a.actionId)) explained.add(`${a.actorOwner}|${f.path}`);
  for (const c of await env.zoo.listClaims()) {
    if (!c.agent.startsWith(`${RUN}:`)) continue;
    if (opts.expectNoClaims && live.length === 0) v.push(`I3: stray claim ${c.agent} ${c.path}`);
    else if (!explained.has(`${c.agent}|${c.path}`)) v.push(`I3: unexplained claim ${c.agent} ${c.path}`);
  }
  return v;
}
