#!/usr/bin/env node
// `synapser`: the operator's console and the MCP entry point.
//   synapser mcp                              serve MCP over stdio (agents connect here)
//   synapser workflow create <file.json>      create a DRAFT
//   synapser workflow list|status <id>|events <id> [--since N]|cancel <id>
//   synapser workflow start <id>              run it in this process until it ends (operator: no start gate)
//   synapser gate list [--workflow ID]        pending human decisions
//   synapser gate show <workflow> <key>       the one-time code you may hand to an agent for MCP approval
//   synapser gate approve|reject <workflow> <key> [--reason TEXT]
//   synapser effect list <workflow>           effects requested, with state and what they would do
//   synapser policy show                      the effect policy in force
//   synapser config show
// Global: --config FILE  --workspace DIR  --state DIR

import { readFileSync } from "node:fs";
import { createRuntime } from "./runtime.ts";
import { ConfigError, loadConfig } from "../config/load.ts";
import { McpServer, serveStdio } from "../mcp/server.ts";
import { currentPlanDigest, decideApproval, isSelfBound, pendingGates, readChallenge } from "../orchestration/gates.ts";
import type { Actor } from "../workflow/manager.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const say = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

const OPERATOR: Actor = { id: `cli:${process.env["USER"] ?? "operator"}`, role: "operator" };

async function main(): Promise<void> {
  const cfgPath = flag("config");
  const ws = flag("workspace");
  const st = flag("state");
  let cfg;
  try {
    cfg = loadConfig({ ...(cfgPath ? { path: cfgPath } : {}) });
  } catch (e) {
    if (e instanceof ConfigError) return die(e.message, 2);
    throw e;
  }
  if (ws) cfg = { ...cfg, workspace: ws };
  if (st) cfg = { ...cfg, stateDir: st };
  const [cmd, sub, a, b] = argv;

  if (cmd === "config" && sub === "show") return say({ ...cfg, profiles: cfg.profiles.map((p) => p.id) });
  if (cmd === "policy" && sub === "show") return say(cfg.policy);

  const rt = createRuntime(cfg);
  const m = rt.manager;
  try {
    switch (cmd) {
      case "mcp": {
        const srv = new McpServer({ manager: m, serverJournal: rt.serverJournal, catalog: rt.catalog });
        process.stderr.write(`synapser mcp: workspace=${cfg.workspace} state=${cfg.stateDir}\n`);
        await serveStdio(srv, process.stdin, process.stdout);
        return;
      }
      case "workflow": {
        if (sub === "create") {
          if (!a) return die("usage: synapser workflow create <file.json>", 2);
          const r = m.create(JSON.parse(readFileSync(a, "utf8")), OPERATOR);
          return r.ok ? say({ workflow_id: r.id, state: "DRAFT" }) : die(JSON.stringify(r, null, 2));
        }
        if (sub === "list") return say(m.list().map((v) => ({ id: v.id, title: v.workflow.title, state: v.state, revision: v.revision })));
        if (sub === "status") return say(m.status(a ?? "") ?? die("unknown workflow", 1));
        if (sub === "events") return say(m.events(a ?? "", Number(flag("since") ?? 0)) ?? die("unknown workflow", 1));
        if (sub === "cancel") return say(m.cancel(a ?? "", OPERATOR));
        if (sub === "start") {
          const id = a ?? "";
          const r = m.start(id, OPERATOR);
          if (!r.ok) return die(`cannot start: ${r.code}`);
          process.on("SIGINT", () => void m.cancel(id, OPERATOR));
          await m.settled(id);
          const v = m.status(id)!;
          say({ workflow_id: id, state: v.state, reason: v.reason, conditions: v.conditions.map((c) => `${c.id}: ${c.status ?? "—"} (${c.evidence ?? "—"})`) });
          return void (process.exitCode = v.state === "DONE" ? 0 : 1);
        }
        break;
      }
      case "effect": {
        if (sub === "list") {
          const b = m.effects(a ?? "");
          return b ? say(b.records().map((r) => ({ id: r.id, kind: r.kind, state: r.state, summary: r.summary, rule: r.rule, evidence: r.evidence }))) : die("unknown workflow", 1);
        }
        break;
      }
      case "gate": {
        if (sub === "list") {
          const only = flag("workflow");
          return say(
            m.list().filter((v) => !only || v.id === only).flatMap((v) => pendingGates(m.journalOf(v.id)!).map((g) => ({ workflow_id: v.id, gate: g.key, summary: g.why, since_seq: g.seq }))),
          );
        }
        const j = a ? m.journalOf(a) : null;
        if (!j || !b) return die("usage: synapser gate show|approve|reject <workflow> <key>", 2);
        const g = pendingGates(j).find((x) => x.key === b);
        if (!g) return die("no such pending gate", 1);
        if (sub === "show") return say({ workflow_id: a, gate: b, code: readChallenge(j, b, g.digest), note: "give this code to the agent ONLY if you approve" });
        if (sub === "approve" || sub === "reject") {
          const r = decideApproval(j, a!, {
            taskId: b, planDigest: g.digest, currentDigest: isSelfBound(b) ? g.digest : currentPlanDigest(j),
            decision: sub === "approve" ? "APPROVED" : "REJECTED", actor: OPERATOR.id, channel: "cli", ...(flag("reason") ? { reason: flag("reason") as string } : {}),
          });
          if (r.ok && b.startsWith("effect:")) await m.settleEffects(a); // run what was just approved (we are the broker's host now)
          return r.ok ? say({ ok: true, gate: b }) : die(`not decided: ${r.code}`);
        }
        break;
      }
    }
    die(`unknown command. See the header of src/cli/main.ts`, 2);
  } finally {
    await rt.close();
  }
}

await main();
