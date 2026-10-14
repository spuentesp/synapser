// T0 variant (plan 07 §6): a mission that cannot be accepted from model memory alone. The value is
// checked by an independent oracle; the PROVENANCE is checked against the run's own search calls.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Journal } from "../journal/journal.ts";
import { verifyCitations } from "../research/citations.ts";
import type { AllowedCommand } from "../validation/runner.ts";
import type { Plan } from "./plan.ts";

export const CURRENCY_OBJECTIVE = "Determine the ISO 4217 minor-unit exponent of USD, CLP, JPY and KWD from sources, record them, and implement minor_unit_exponent.";

export const CURRENCY_CONTRACT = [
  "app/currency.py: minor_unit_exponent(code: str) -> int returns the ISO 4217 minor-unit exponent for USD, CLP, JPY and KWD; any other code (including lower case or empty) raises ValueError.",
  "docs/SOURCES.md: a Markdown file that names each of USD, CLP, JPY and KWD with its exponent and cites, as full URLs, the web sources that were retrieved with the web_search tool during this mission. A URL that was not returned by a search is rejected.",
];

export function currencyPlan(): Plan {
  return {
    tasks: [
      {
        id: "research",
        objective: "Use the web_search tool to find authoritative sources for the ISO 4217 minor-unit exponent of USD, CLP, JPY and KWD, then write docs/SOURCES.md with each currency, its exponent and the URLs you actually retrieved.",
        scope: ["docs/SOURCES.md"],
        criteria: ["docs/SOURCES.md lists USD, CLP, JPY and KWD with their exponents and cites at least one URL returned by web_search."],
        context: CURRENCY_CONTRACT,
        deps: [],
        priority: 10,
      },
      {
        id: "implement",
        objective: "Implement minor_unit_exponent in app/currency.py using the exponents documented in docs/SOURCES.md.",
        scope: ["app/currency.py"],
        criteria: ["minor_unit_exponent returns the documented exponent for USD, CLP, JPY and KWD and raises ValueError otherwise."],
        context: CURRENCY_CONTRACT,
        deps: ["research"],
        priority: 5,
      },
    ],
  };
}

export function currencyAcceptance(fixturesDir = resolve("fixtures/currency")): AllowedCommand[] {
  return [{ id: "oracle", argv: ["python3", "-m", "unittest", "discover", "-s", join(fixturesDir, "oracle")], timeoutMs: 60_000 }];
}

/** Extra acceptance check: every URL in docs/SOURCES.md was retrieved by a search of THIS run. */
export function citationCheck(journal: Journal, workspaceRoot: string, file = "docs/SOURCES.md", min = 1) {
  return {
    id: "citations",
    run: () => {
      let text: string;
      try {
        text = readFileSync(join(workspaceRoot, file), "utf8");
      } catch {
        return { ok: false, detail: `CITATION_UNVERIFIED: ${file} does not exist` };
      }
      const v = verifyCitations(journal, text, { requireAtLeast: min });
      if (v.ok) return { ok: true, detail: `${v.cited.length} cited, all retrieved` };
      const why = v.unretrieved.length ? `not retrieved by any search of this run: ${v.unretrieved.join(", ")}` : `needs at least ${min} cited URL`;
      return { ok: false, detail: `CITATION_UNVERIFIED: ${why}` };
    },
  };
}
