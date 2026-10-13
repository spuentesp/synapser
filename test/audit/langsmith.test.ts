import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { detUuid7, ledgerToRuns, LangSmithError, sendRuns } from "../../src/audit/langsmith.ts";
import { verify } from "../../src/audit/queries.ts";
import { type Env, makeEnv } from "../executor/env.ts";
import { buildScenario } from "./scenario.ts";

describe("LangSmith exporter (coding-agent-v1)", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    await buildScenario(env);
  });
  afterEach(async () => env.close());

  const map = (includeContent = false) => ledgerToRuns(env.journal, { project: "synapser-test", includeContent });

  test("one trace: a single root, valid parent links, dotted_order nesting, ordered times", () => {
    const runs = map();
    const roots = runs.filter((r) => !r.parent_run_id);
    assert.equal(roots.length, 1);
    const byId = new Map(runs.map((r) => [r.id, r]));
    assert.equal(byId.size, runs.length, "ids are unique");
    for (const r of runs) {
      assert.equal(r.trace_id, roots[0]!.id);
      assert.ok(new Date(r.end_time) >= new Date(r.start_time));
      assert.match(r.dotted_order, /^\d{8}T\d{6}\d{6}Z[0-9a-f-]{36}(\.\d{8}T\d{6}\d{6}Z[0-9a-f-]{36})*$/);
      if (r.parent_run_id) {
        const parent = byId.get(r.parent_run_id)!;
        assert.ok(parent, "parent exists in the same export");
        assert.ok(r.dotted_order.startsWith(`${parent.dotted_order}.`), "child's dotted_order extends its parent's");
      }
    }
    const kinds = runs.reduce<Record<string, number>>((a, r) => ((a[r.run_type] = (a[r.run_type] ?? 0) + 1), a), {});
    assert.ok((kinds["chain"] ?? 0) >= 5 && (kinds["llm"] ?? 0) >= 2 && (kinds["tool"] ?? 0) >= 3, JSON.stringify(kinds));
  });

  test("every run carries the coding-agent identity block; the root carries the ledger head", () => {
    const runs = map();
    for (const r of runs.filter((x) => x.run_type !== "llm" || x.extra.metadata["ls_agent_type"])) {
      const m = r.extra.metadata;
      assert.equal(m["ls_integration"], "synapser", r.name);
      assert.equal(m["ls_agent_purpose"], "coding");
      assert.equal(m["ls_trace_schema_version"], "coding-agent-v1");
      assert.equal(m["thread_id"], env.journal.runId);
      assert.ok(["root", "subagent"].includes(String(m["ls_agent_type"])));
    }
    const root = runs.find((r) => !r.parent_run_id)!;
    assert.equal(root.extra.metadata["synapser_ledger_head"], verify(env.journal).head, "the trace can be checked against the chain");
    for (const r of runs.filter((x) => x.extra.metadata["ls_agent_type"] === "subagent" && x.run_type === "chain")) {
      assert.ok(r.extra.metadata["ls_subagent_id"] && r.extra.metadata["ls_subagent_type"]);
    }
    for (const r of runs.filter((x) => x.run_type === "tool")) assert.ok(r.extra.metadata["ls_tool_name"], r.name);
  });

  test("usage_metadata is exact when reported and ABSENT (not zero) when unknown", () => {
    const runs = map();
    const llm = (profile: string) => {
      const parent = runs.find((r) => r.name === profile && r.run_type === "chain")!;
      return runs.filter((r) => r.parent_run_id === parent.id && r.run_type === "llm");
    };
    const good = llm("cli-good")[0]!;
    assert.deepEqual(good.extra.metadata["usage_metadata"], {
      input_tokens: 1000, // 600 net + 400 cache read
      output_tokens: 50,
      total_tokens: 1050,
      input_token_details: { cache_read: 400, cache_creation: 0 },
      output_token_details: { reasoning: 10 },
    });
    // the native run's scripted model recorded no model_calls: nothing is invented
    assert.equal(llm("nemotron-worker").length, 0);
    assert.equal(llm("cli-bad").length, 0);
    assert.equal(good.extra.metadata["synapser_usage_provenance"], "reported");
  });

  test("failures and refusals are errors on the right runs; integrations hang under the run that caused them", () => {
    const runs = map();
    assert.match(runs.find((r) => r.name === "cli-bad")!.error ?? "", /402/);
    assert.equal(runs.find((r) => r.name === "cli-good")!.error, undefined);
    const stale = runs.find((r) => r.run_type === "tool" && r.extra.metadata["synapser_state"] === "SETTLED" && r.error === "STALE_VIEW");
    assert.ok(stale, "the stale integration is an error tool run");
    const parent = runs.find((r) => r.id === stale!.parent_run_id)!;
    assert.equal(parent.name, "cli-stale", "linked by the integration record, not by time");
    const v = runs.filter((r) => r.name.startsWith("validation:"));
    assert.equal(v.length, 0, "this scenario has no validation runs");
  });

  test("PRIVACY: nothing the agents read, wrote or were told leaves by default; content is opt-in", () => {
    const blob = JSON.stringify(map(false));
    for (const secret of ["Append a marker to the schema", "Edit the client", "# native marker", "# edited by the agent", "client edit", "I appended a marker so the schema is documented", "task t1"]) {
      assert.equal(blob.includes(secret), false, `leaked: ${secret}`);
    }
    assert.match(blob, /prompt_blob/, "ids/digests are fine");
    const withContent = JSON.stringify(map(true));
    assert.match(withContent, /task t3/, "opt-in includes the prompt text");
  });

  test("deterministic ids: exporting twice yields the same runs (idempotent re-export)", () => {
    assert.deepEqual(map().map((r) => r.id), map().map((r) => r.id));
    assert.equal(detUuid7(1_700_000_000_000, "x"), detUuid7(1_700_000_000_000, "x"));
    assert.notEqual(detUuid7(1_700_000_000_000, "x"), detUuid7(1_700_000_000_000, "y"));
    assert.match(detUuid7(1_700_000_000_000, "x"), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("multipart transport: part names, headers, chunking, and a key that never appears in an error", async () => {
    const runs = map();
    const sent: { url: string; headers: Record<string, string>; parts: string[]; text: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const text = Buffer.from(init.body as Buffer).toString("utf8");
      sent.push({ url, headers: init.headers as Record<string, string>, parts: [...text.matchAll(/name="([^"]+)"/g)].map((m) => m[1] as string), text });
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const r = await sendRuns(runs, { apiKey: "lsv2_secret_key", workspaceId: "ws-1", fetch: fake, batchSize: 4 });
    assert.equal(r.runs, runs.length);
    assert.equal(r.requests, Math.ceil(runs.length / 4));
    assert.equal(sent[0]!.url, "https://api.smith.langchain.com/runs/multipart");
    assert.equal(sent[0]!.headers["x-api-key"], "lsv2_secret_key");
    assert.equal(sent[0]!.headers["x-tenant-id"], "ws-1");
    assert.match(sent[0]!.headers["content-type"] ?? "", /^multipart\/form-data; boundary=synapser-[0-9a-f]{24}$/);
    // every part declares its Content-Length, and it is the TRUE byte length of that part's body
    for (const s of sent) {
      const parts = s.text.split(/--synapser-[0-9a-f]{24}(?:--)?\r\n/).filter((x) => x.includes("Content-Length"));
      assert.ok(parts.length > 0);
      for (const p of parts) {
        const [head, ...rest] = p.split("\r\n\r\n");
        const declared = Number(/Content-Length: (\d+)/.exec(head!)![1]);
        const body = rest.join("\r\n\r\n").replace(/\r\n$/, "");
        assert.equal(Buffer.byteLength(body, "utf8"), declared);
      }
    }
    const names = sent.flatMap((s) => s.parts);
    for (const run of runs) assert.ok(names.includes(`post.${run.id}`));
    assert.ok(names.every((n) => /^post\.[0-9a-f-]{36}(\.(inputs|outputs))?$/.test(n)));

    const refuse = (async () => new Response('{"detail":"bad key lsv2_secret_key"}', { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(sendRuns(runs, { apiKey: "lsv2_secret_key", fetch: refuse }), (e) => e instanceof LangSmithError && e.status === 403 && !e.message.includes("lsv2_secret_key"));
    void readFileSync;
  });
});
