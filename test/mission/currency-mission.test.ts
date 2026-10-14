// T0: a mission accepted only by value AND provenance. The oracle checks the numbers; the citation
// check proves the URLs were RETRIEVED in this run, so memory alone cannot pass it.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { citationCheck, CURRENCY_OBJECTIVE, currencyAcceptance, currencyPlan } from "../../src/mission/currency-fixture.ts";
import { runMission } from "../../src/mission/runner.ts";
import { ReplayResearch } from "../../src/research/adapters.ts";
import { QueryGuard } from "../../src/research/guard.ts";
import { ResearchSession } from "../../src/research/session.ts";
import { LocalRunner } from "../../src/validation/runner.ts";
import { call, lastTool, ScriptedModel } from "../agent/scripted.ts";
import { type Env, makeEnv, RUN } from "../executor/env.ts";
import { readFileSync } from "node:fs";

const FX = resolve("fixtures/currency");
const SOL = readFileSync(join(FX, "solution/app/currency.py"), "utf8");
const QUERY = { query: "ISO 4217 minor unit exponent USD CLP JPY KWD", maxResults: 3, depth: "basic" as const };
const RETRIEVED = "https://www.iso.org/iso-4217-currency-codes.html";

test("fixture contract: the oracle rejects the stubs and accepts the reference solution", () => {
  const run = (kind: string, withSources: boolean) => {
    const d = mkdtempSync(join(tmpdir(), "cur-fx-"));
    try {
      cpSync(join(FX, kind), d, { recursive: true });
      if (kind === "solution" || withSources) {
        cpSync(join(FX, "baseline/docs"), join(d, "docs"), { recursive: true });
        spawnSync("sh", ["-c", `echo "USD CLP JPY KWD" > ${join(d, "docs/SOURCES.md")}`]);
      }
      if (kind === "solution") cpSync(join(FX, "baseline/tests"), join(d, "tests"), { recursive: true });
      const c = currencyAcceptance(FX)[0]!;
      return spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: d, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" } }).status;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  assert.notEqual(run("baseline", true), 0);
  assert.equal(run("solution", true), 0);
});

describe("research-required mission", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    cpSync(join(FX, "baseline"), env.ws, { recursive: true });
  });
  afterEach(async () => env.close());

  const research = () =>
    new ResearchSession({
      port: new ReplayResearch([{ query: QUERY, results: [{ url: RETRIEVED, title: "ISO 4217", content: "USD 2, CLP 0, JPY 0, KWD 3", score: 1 }] }]),
      journal: env.journal,
      runId: RUN,
      guard: new QueryGuard(env.ws, {}),
    });

  /** researcher: search → write SOURCES.md citing `cite`; implementer: write the reference solution. */
  const agents = (cite: string) =>
    new ScriptedModel((messages) => {
      const first = messages.find((m) => m.role === "user")!.content!;
      const isResearch = /web_search tool to find authoritative sources/.test(first);
      const last = lastTool(messages);
      if (isResearch) {
        if (last === null) return { calls: [call("web_search", QUERY.query ? { query: QUERY.query, max_results: 3 } : {})] };
        if (last.results) return { calls: [call("read_files", { paths: ["docs/SOURCES.md"] })] };
        if (last.files) {
          const md = `# Sources\n\n- USD: 2\n- CLP: 0\n- JPY: 0\n- KWD: 3\n\nSource: ${cite}\n`;
          return { calls: [call("write_file", { path: "docs/SOURCES.md", content: md }), call("apply_changes", {})] };
        }
        return { calls: [call("finish", { summary: "documented" })] };
      }
      if (last === null) return { calls: [call("read_files", { paths: ["app/currency.py"] })] };
      if (last.files) return { calls: [call("write_file", { path: "app/currency.py", content: SOL }), call("apply_changes", {})] };
      return { calls: [call("finish", { summary: "implemented" })] };
    });

  const go = (model: ScriptedModel) =>
    runMission(
      {
        executor: env.exec,
        journal: env.journal,
        model,
        research: research(),
        validation: new LocalRunner({ journal: env.journal, runId: RUN, workspaceRoot: env.ws, commands: currencyAcceptance(FX), generation: env.lock.generation }),
        extraChecks: [citationCheck(env.journal, env.ws)],
      },
      { runId: RUN, objective: CURRENCY_OBJECTIVE, plan: currencyPlan(), acceptance: ["oracle"], limits: { concurrency: 2, maxRepairRounds: 0, missionMs: 60_000 } },
    );

  test("DONE: value correct AND the cited URL was retrieved by a search of this run", async () => {
    const r = await go(agents(RETRIEVED));
    assert.equal(r.status, "DONE", r.reason ?? "");
    assert.deepEqual(env.journal.listResearchCalls().map((c) => c.urls), [[RETRIEVED]]);
    const checks = env.journal.listEvents().filter((e) => e.entity === "acceptance_check");
    assert.deepEqual(checks.map((c) => `${(c.data as { check: string }).check}:${c.toState}`), ["citations:PASSED"]);
  });

  test("FAILED: correct values but a cited source that was never retrieved (memory is not a source)", async () => {
    const r = await go(agents("https://invented.example/iso-4217-says-so"));
    assert.equal(r.status, "FAILED");
    const checks = env.journal.listEvents().filter((e) => e.entity === "acceptance_check");
    assert.equal(checks[0]!.toState, "FAILED");
    assert.match(String((checks[0]!.data as { detail: string }).detail), /CITATION_UNVERIFIED.*invented\.example/);
  });
});
