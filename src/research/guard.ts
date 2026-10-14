// A search query is an OUTBOUND DATA FLOW to a third party (plan 07 §4). The guard refuses what
// looks like source code copied from the workspace or a credential, before anything leaves.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listTree } from "../validation/snapshot.ts";

const WINDOW = 32;
const MAX_QUERY = 200;
const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;

const SECRET_PATTERNS: [string, RegExp][] = [
  ["tavily-key", /tvly-[A-Za-z0-9_-]{8,}/],
  ["langsmith-key", /lsv2_[A-Za-z0-9_]{8,}/],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["long-hex", /\b[A-Fa-f0-9]{40,}\b/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
  ["assignment", /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{8,}/i],
];

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const short = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

export type GuardVerdict = { ok: true } | { ok: false; reason: "TOO_LONG" | "MULTILINE" | "EMPTY" | "WORKSPACE_TEXT" | "SECRET"; detail: string };

export class QueryGuard {
  readonly #windows = new Set<string>();
  readonly #secrets: string[];

  constructor(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env) {
    let total = 0;
    for (const rel of listTree(workspaceRoot)) {
      let text: string;
      try {
        const abs = join(workspaceRoot, rel);
        const st = statSync(abs);
        if (st.size > MAX_FILE || total + st.size > MAX_TOTAL) continue;
        text = norm(readFileSync(abs, "utf8"));
        total += st.size;
      } catch {
        continue;
      }
      // index windows that start at a word boundary: any contiguous copy of >= WINDOW+word chars contains one
      for (let i = 0; i + WINDOW <= text.length; i++) {
        if (i === 0 || text[i - 1] === " ") this.#windows.add(short(text.slice(i, i + WINDOW)));
      }
    }
    // the literal values of our own credentials never leave, whatever they look like
    this.#secrets = Object.entries(env)
      .filter(([k, v]) => /(KEY|TOKEN|SECRET|PASSWORD)/i.test(k) && typeof v === "string" && v.length >= 12)
      .map(([, v]) => v as string);
  }

  check(query: string): GuardVerdict {
    if (query.trim().length === 0) return { ok: false, reason: "EMPTY", detail: "empty query" };
    if (query.length > MAX_QUERY) return { ok: false, reason: "TOO_LONG", detail: `at most ${MAX_QUERY} characters` };
    if (/[\r\n]/.test(query)) return { ok: false, reason: "MULTILINE", detail: "a query is one line of keywords, not pasted text" };
    for (const [name, re] of SECRET_PATTERNS) if (re.test(query)) return { ok: false, reason: "SECRET", detail: name };
    if (this.#secrets.some((s) => query.includes(s))) return { ok: false, reason: "SECRET", detail: "value of a configured credential" };
    const q = norm(query);
    for (let i = 0; i + WINDOW <= q.length; i++) {
      if (this.#windows.has(short(q.slice(i, i + WINDOW)))) {
        return { ok: false, reason: "WORKSPACE_TEXT", detail: "the query contains text copied from the repository; describe the question instead" };
      }
    }
    return { ok: true };
  }
}
