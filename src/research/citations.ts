// "No citation without retrieval" (plan 07 §5): a URL an artifact cites must have been returned by a
// search call of THIS run. The model cannot remember a source and present it as consulted.

import type { Journal } from "../journal/journal.ts";

const URL_RE = /https?:\/\/[^\s<>)\]"'`]+/g;

const canon = (u: string): string => {
  try {
    const x = new URL(u.replace(/[.,;:]+$/, ""));
    x.hash = "";
    let s = `${x.protocol}//${x.host.toLowerCase()}${x.pathname}${x.search}`;
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
};

export interface CitationVerdict {
  ok: boolean;
  cited: string[];
  unretrieved: string[];
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map(canon))];
}

/** URLs returned by successful searches of this run (cache hits included). */
export function retrievedUrls(journal: Journal): Set<string> {
  const out = new Set<string>();
  for (const c of journal.listResearchCalls()) if (!c.error) for (const u of c.urls) out.add(canon(u));
  return out;
}

export function verifyCitations(journal: Journal, text: string, opts: { requireAtLeast?: number } = {}): CitationVerdict {
  const cited = extractUrls(text);
  const got = retrievedUrls(journal);
  const unretrieved = cited.filter((u) => !got.has(u));
  const ok = unretrieved.length === 0 && cited.length >= (opts.requireAtLeast ?? 0);
  return { ok, cited, unretrieved };
}
