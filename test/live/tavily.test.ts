// Live: ONE real search (1 credit). Skipped without a key. Checks the wire contract we depend on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFromEnv } from "../../src/research/index.ts";

const has = Boolean(process.env["TAVILY_API_KEY"] || process.env["TAVILY_TOKEN"]);

test("Tavily: a real query returns sourced results and reports usage", { skip: has ? false : "no Tavily key in the environment", timeout: 60_000 }, async () => {
  const port = researchFromEnv();
  assert.equal(port.provider, "tavily");
  const r = await port.search({ query: "ISO 4217 minor unit exponent of the Chilean peso CLP", maxResults: 3, depth: "basic" }, { runId: "live", role: "worker" });
  console.log(`results=${r.results.length} credits=${String(r.creditsUsed)} latencyMs=${r.latencyMs}`);
  console.log(r.results.map((x) => `${new URL(x.url).host} score=${x.score.toFixed(2)}`).join(" | "));
  assert.ok(r.results.length >= 1);
  for (const x of r.results) {
    assert.match(x.url, /^https?:\/\//);
    assert.ok(x.content.length > 0 && x.content.length <= 1500);
  }
});
