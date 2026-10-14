// What earlier workflows taught us about each agent's real cost and reliability (plan 10 §2.1). Read-only
// over the other runs' ledgers; recent first, bounded. An estimate is therefore a function of RECORDS.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "../journal/journal.ts";
import { type RunSample, samplesFromJournal } from "./catalog.ts";

export function loadHistory(stateDir: string, excludeRunId: string, max = 300): RunSample[] {
  if (!existsSync(stateDir)) return [];
  const dirs = readdirSync(stateDir)
    .filter((n) => n !== excludeRunId && !n.startsWith("_") && existsSync(join(stateDir, n, "journal.db")))
    .map((n) => ({ n, t: statSync(join(stateDir, n, "journal.db")).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const out: RunSample[] = [];
  for (const { n } of dirs) {
    let j: Journal | null = null;
    try {
      j = Journal.open(stateDir, n);
      out.push(...samplesFromJournal(j));
    } catch {
      /* a damaged or foreign directory contributes nothing */
    } finally {
      j?.close();
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
