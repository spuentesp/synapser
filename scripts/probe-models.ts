// Spike S-A (plan 06 §12): what do the Nemotron models on THIS account actually do?
// Usage: node --env-file=.env scripts/probe-models.ts [model-id ...]
// The key is read from NEBIUS_API_KEY, NEBIUS_TOKEN or NEMOTRON_TOKEN and is never printed or written.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env["TOKENFACTORY_BASE_URL"] ?? "https://api.tokenfactory.nebius.com/v1/";
const KEY = process.env["NEBIUS_API_KEY"] ?? process.env["NEBIUS_TOKEN"] ?? process.env["NEMOTRON_TOKEN"];
if (!KEY) {
  console.error("no NEBIUS_API_KEY / NEBIUS_TOKEN / NEMOTRON_TOKEN in the environment");
  process.exit(2);
}

const DEFAULT_MODELS = [
  "nvidia/Nemotron-3_5-Lightning",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/Nemotron-3-Ultra-550b-a55b",
];
const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;

const readFiles = {
  type: "function",
  function: {
    name: "read_files",
    description: "Read workspace files and return their content and digest.",
    parameters: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
} as const;
const proposePatch = {
  type: "function",
  function: {
    name: "propose_patch",
    description: "Propose an exact-string replacement in one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
      additionalProperties: false,
    },
  },
} as const;

interface Chat {
  status: number;
  ms: number;
  body: any;
  headers: Record<string, string>;
}

async function chat(payload: object): Promise<Chat> {
  const t0 = Date.now();
  const res = await fetch(new URL("chat/completions", BASE), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.startsWith("x-ratelimit") || k === "retry-after") headers[k] = v;
  });
  return { status: res.status, ms: Date.now() - t0, body, headers };
}

const msgOf = (c: Chat) => c.body?.choices?.[0]?.message ?? {};
const usageOf = (c: Chat) => c.body?.usage ?? null;
function parseCalls(m: any): { name: string; args: unknown; argsValid: boolean }[] {
  return (m.tool_calls ?? []).map((tc: any) => {
    try {
      return { name: tc.function?.name, args: JSON.parse(tc.function?.arguments ?? ""), argsValid: true };
    } catch {
      return { name: tc.function?.name, args: tc.function?.arguments, argsValid: false };
    }
  });
}
const reasoningShape = (m: any) => ({
  reasoning_content_field: typeof m.reasoning_content === "string" && m.reasoning_content.length > 0,
  reasoning_field: typeof m.reasoning === "string" && m.reasoning.length > 0,
  think_tags_in_content: typeof m.content === "string" && /<think>|<\/think>/i.test(m.content),
});

async function probe(model: string) {
  const out: Record<string, unknown> = { model };
  const base = { model, max_tokens: 700, temperature: 0 };

  const a = await chat({ ...base, messages: [{ role: "user", content: "Reply with exactly: OK" }] });
  out["plain"] = {
    status: a.status,
    ms: a.ms,
    servedModel: a.body?.model,
    content: String(msgOf(a).content ?? "").slice(0, 80),
    usage: usageOf(a),
    reasoning: reasoningShape(msgOf(a)),
    error: a.status >= 400 ? a.body : undefined,
  };

  const b = await chat({
    ...base,
    tools: [readFiles],
    tool_choice: { type: "function", function: { name: "read_files" } },
    messages: [{ role: "user", content: "Read app/billing.py and app/schema.py." }],
  });
  const bc = parseCalls(msgOf(b));
  out["forcedToolCall"] = {
    status: b.status,
    ms: b.ms,
    calls: bc,
    ok: bc.length >= 1 && bc.every((c) => c.argsValid && c.name === "read_files" && Array.isArray((c.args as any)?.paths)),
    finish: b.body?.choices?.[0]?.finish_reason,
    usage: usageOf(b),
    error: b.status >= 400 ? b.body : undefined,
  };

  const c = await chat({
    ...base,
    tools: [readFiles, proposePatch],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "You are a coding agent. Use the tools. Do not answer in prose." },
      { role: "user", content: "In app/billing.py replace the text `total_cents=invoice.subtotal_cents` with `total_cents=0`. First read the file." },
    ],
  });
  const cc = parseCalls(msgOf(c));
  out["autoToolCall"] = {
    status: c.status,
    ms: c.ms,
    calls: cc.map((x) => ({ name: x.name, argsValid: x.argsValid })),
    parallelCalls: cc.length > 1,
    firstIsRead: cc[0]?.name === "read_files",
    proseInsteadOfTool: cc.length === 0 && String(msgOf(c).content ?? "").length > 0,
    finish: c.body?.choices?.[0]?.finish_reason,
    reasoning: reasoningShape(msgOf(c)),
    usage: usageOf(c),
    headers: c.headers,
    error: c.status >= 400 ? c.body : undefined,
  };

  const schema = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } },
          required: ["id", "depends_on"],
        },
      },
    },
    required: ["tasks"],
  };
  const d = await chat({
    ...base,
    response_format: { type: "json_schema", json_schema: { name: "plan", schema } },
    messages: [
      { role: "system", content: `Return only JSON matching this schema: ${JSON.stringify(schema)}` },
      { role: "user", content: "Plan two tasks: t1 has no dependencies; t2 depends on t1." },
    ],
  });
  let parsed: any = null;
  try {
    parsed = JSON.parse(String(msgOf(d).content ?? ""));
  } catch {
    /* invalid */
  }
  out["jsonSchema"] = {
    status: d.status,
    ms: d.ms,
    valid: Array.isArray(parsed?.tasks) && parsed.tasks.length === 2,
    usage: usageOf(d),
    error: d.status >= 400 ? d.body : undefined,
  };
  return out;
}

const results = [];
for (const m of models) {
  process.stdout.write(`probing ${m} … `);
  try {
    const r = await probe(m);
    results.push(r);
    const f = r["forcedToolCall"] as any;
    const au = r["autoToolCall"] as any;
    const j = r["jsonSchema"] as any;
    console.log(`forced:${f.ok ? "ok" : "FAIL"} auto:${au.firstIsRead ? "ok" : "no-read-first"} parallel:${au.parallelCalls} json:${j.valid ? "ok" : "FAIL"}`);
  } catch (e) {
    console.log("ERROR", String((e as Error).message));
    results.push({ model: m, error: String((e as Error).message) });
  }
}
mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/models.json",
  JSON.stringify({ at: new Date().toISOString(), baseUrl: BASE, results }, null, 2) + "\n",
);
console.log("wrote evidence/models.json");
