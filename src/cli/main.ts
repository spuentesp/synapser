#!/usr/bin/env node
// `synapser`: the operator's console and the MCP entry point.
//   synapser mcp                              serve MCP over stdio (agents connect here)
//   synapser mcp artifact import <dir> <entrypoint>  pin a local MCP package tree
//   synapser workflow create <file.json>      create a DRAFT
//   synapser workflow list|status <id>|events <id> [--since N]|cancel <id>
//   synapser workflow start <id>              run it in this process until it ends (operator: no start gate)
//   synapser gate list [--workflow ID]        pending human decisions
//   synapser gate show <workflow> <key>       the one-time code you may hand to an agent for MCP approval
//   synapser gate approve|reject <workflow> <key> [--reason TEXT]
//   synapser advisor list <workflow>          interventions and their state
//   synapser advisor ask <workflow> "question" ask Nemotron; it PROPOSES, nothing is applied
//   synapser advisor apply <workflow> <iv-id>  apply a proposal (a rollback opens a gate instead)
//   synapser advisor release <workflow> <task> release a held task
//   synapser effect list <workflow>           effects requested, with state and what they would do
//   synapser policy show                      the effect policy in force
//   synapser serve [--port 4173]              the UI + API + chat over this config (127.0.0.1 only)
//   synapser doctor [--json]                  what is installed and usable, and what to enable
//   synapser provider test <id>               list a provider's models and make one minimal call (key never printed)
//   synapser config show
//   synapser config put <providers|roles|agents> <id> <file.json>  write through the authenticated API
// Global: --config FILE  --workspace DIR  --state DIR

import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { doctor } from "./doctor.ts";
import { createRuntime } from "./runtime.ts";
import { writeLiveConfig } from "../config/write.ts";
import { ConfigError, loadConfig } from "../config/load.ts";
import { testProviderConnection } from "../model/connection.ts";
import { readLibrary } from "../library/store.ts";
import { libraryPolicyOf } from "../library/validate.ts";
import { McpServer, serveStdio } from "../mcp/server.ts";
import { currentPlanDigest, decideApproval, isSelfBound, pendingGates, readChallenge } from "../orchestration/gates.ts";
import type { Actor } from "../workflow/manager.ts";
import { importMcpArtifact } from "../mcp/artifact-store.ts";

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

async function putConfig(kind: string | undefined, id: string | undefined, file: string | undefined): Promise<void> {
  if (kind !== "providers" && kind !== "roles" && kind !== "agents") return die("usage: synapser config put <providers|roles|agents> <id> <file.json>", 2);
  if (!id || !file) return die("usage: synapser config put <providers|roles|agents> <id> <file.json>", 2);
  const token = process.env["SYNAPSER_OPERATOR_TOKEN"];
  if (!token || token.length < 32) return die("SYNAPSER_OPERATOR_TOKEN must be set to the operator token (at least 32 characters)", 2);
  let api: URL;
  let value: unknown;
  try {
    api = new URL(process.env["SYNAPSER_API_URL"] ?? "http://127.0.0.1:4173");
    if (api.protocol !== "http:" && api.protocol !== "https:") throw new Error("unsupported protocol");
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return die(error instanceof SyntaxError ? `invalid JSON in ${file}` : error instanceof Error && error.message === "unsupported protocol" ? "SYNAPSER_API_URL must use HTTP or HTTPS" : `cannot read configuration document: ${file}`, 2);
  }
  try {
    const response = await fetch(new URL(`/api/config/${kind}/${encodeURIComponent(id)}`, api), {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-synapser-token": token, origin: api.origin },
      body: JSON.stringify(value),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return die(JSON.stringify(body), response.status === 401 ? 1 : 2);
    return say({ ok: true, kind, id });
  } catch {
    return die("configuration API request failed; check SYNAPSER_API_URL and that Synapser serve is running", 1);
  }
}

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

  if (cmd === "mcp" && sub === "artifact" && a === "import") {
    const entrypoint = argv[4];
    if (!b || !entrypoint || entrypoint.startsWith("/") || entrypoint.includes("\\") ||
      entrypoint.split("/").some((part) => part.length === 0 || part === "." || part === "..") || entrypoint.includes("\0")) {
      return die("usage: synapser mcp artifact import <local-directory> <relative-entrypoint>", 2);
    }
    try {
      const source = resolve(b);
      const sourceEntrypoint = resolve(source, ...entrypoint.split("/"));
      const entrypointRelative = relative(source, sourceEntrypoint);
      const sourceStat = lstatSync(sourceEntrypoint);
      if (entrypointRelative.startsWith("..") || !sourceStat.isFile() || sourceStat.isSymbolicLink()) return die("entrypoint must name a regular file in the imported artifact", 2);
      const imported = importMcpArtifact(source, join(cfg.stateDir, "mcp-artifacts"));
      return say({ digest: imported.digest, entrypoint, note: "Package tree is pinned; the configured host runtime and its system libraries are not included in this digest." });
    } catch (error) {
      return die(`MCP artifact import failed: ${String((error as Error).message ?? error).slice(0, 240)}`, 2);
    }
  }

  if (cmd === "config" && sub === "show") {
    // the library next to the file (plan 14 Q2.7): its index only; the documents are read through the API
    let library: unknown;
    try {
      library = readLibrary(cfg.stateDir).map(({ kind, id, digest, seq, actor }) => ({ kind, id, digest, seq, actor }));
    } catch (e) {
      library = { error: String((e as Error).message ?? e).slice(0, 200) };
    }
    return say({ ...cfg, profiles: cfg.profiles.map((p) => p.id), library });
  }
  if (cmd === "config" && sub === "put") return await putConfig(a, b, argv[4]);
  if (cmd === "policy" && sub === "show") return say(cfg.policy);
  if (cmd === "provider" && sub === "test") {
    const id = a ?? "";
    if (!Object.hasOwn(cfg.providers, id)) return die(`unknown provider ${JSON.stringify(id)} (configured: ${Object.keys(cfg.providers).join(", ")})`, 2);
    const rep = await testProviderConnection(cfg.providers[id]!);
    say({ provider: id, ...rep });
    return void (process.exitCode = rep.ok ? 0 : 1);
  }
  if (cmd === "doctor") {
    const rep = await doctor(cfg);
    if (sub === "--json" || argv.includes("--json")) return say(rep);
    for (const c of rep.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    console.log("\nAgents:");
    for (const a of rep.agents) console.log(`${a.available ? "✓" : "✗"} ${a.id.padEnd(22)} ${a.tier.padEnd(9)} ${a.role.padEnd(8)} ${a.enabledInConfig ? "enabled " : "        "} ${a.detail}`);
    if (rep.suggestions.length) console.log(`\nSuggestions:\n- ${rep.suggestions.join("\n- ")}`);
    return void (process.exitCode = rep.ok ? 0 : 1);
  }

  const rt = createRuntime(cfg);
  const m = rt.manager;
  try {
    switch (cmd) {
      case "serve": {
        const { createApi } = await import("../api/server.ts");
        const { discoverRegisteredMcpServer } = await import("../mcp/discovery.ts");
        const pi = argv.indexOf("--port");
        // plan 17 P17.8: a fixed operator token, from the environment, so writes survive a restart and clients can hold it.
        const operatorToken = process.env["SYNAPSER_OPERATOR_TOKEN"];
        if (operatorToken !== undefined && operatorToken.length < 32) throw new Error("SYNAPSER_OPERATOR_TOKEN must be at least 32 characters");
        const api = createApi({
          ...(operatorToken ? { token: operatorToken } : {}),
          stateDir: cfg.stateDir,
          trustMode: cfg.trustMode,
          control: { manager: rt.manager, chat: rt.chat, library: rt.library, trialAgent: rt.trialAgent, configWrite: (change) => writeLiveConfig(cfg, change), libraryPolicy: () => libraryPolicyOf(cfg), catalog: () => rt.catalog(), mcpServers: () => cfg.mcpServers, mcpDiscover: async (serverId, profileId) => {
            const registration = cfg.mcpServers.find((server) => server.id === serverId);
            if (!registration) throw new Error("unknown registered MCP server");
            return discoverRegisteredMcpServer(registration, profileId, join(cfg.stateDir, "mcp-artifacts"));
          }, config: () => ({ workspace: cfg.workspace, commands: cfg.commands.map((c) => c.id), profiles: cfg.profiles.map((p) => ({ id: p.id, tier: p.tier ?? "standard", role: p.role, enabled: p.enabled, pool: p.pool ?? null })), pools: cfg.pools, agentSkills: cfg.agentSkills, policy: cfg.policy, startRequiresApproval: cfg.startRequiresApproval, advisor: cfg.advisor, providers: cfg.providers, roles: cfg.roles }) },
        });
        const port = await api.listen(pi >= 0 ? Number(argv[pi + 1]) : 4173);
        console.log(`Synapser → http://127.0.0.1:${port}/  (workspace: ${cfg.workspace})`);
        if (api.sessionCode) console.log(`Código de sesión (un solo uso, para la página): ${api.sessionCode}`);
        return await new Promise<void>(() => {});
    }
      case "mcp": {
        const srv = new McpServer({ manager: m, serverJournal: rt.serverJournal, catalog: rt.catalog, library: rt.library });
        process.stderr.write(`synapser mcp: workspace=${cfg.workspace} state=${cfg.stateDir}\n`);
        await serveStdio(srv, process.stdin, process.stdout);
        return;
      }
      case "mcp-config": {
        // plan 17 P17.8 step 3: the configuration connector. Its token comes from the environment and is never printed.
        const { ConfigConnector } = await import("../mcp/config-connector.ts");
        const connector = new ConfigConnector({ apiUrl: process.env["SYNAPSER_API_URL"] ?? "http://127.0.0.1:4173", token: process.env["SYNAPSER_OPERATOR_TOKEN"] ?? "" });
        process.stderr.write("synapser mcp-config: configuration connector ready (token from SYNAPSER_OPERATOR_TOKEN)\n");
        await serveStdio(connector, process.stdin, process.stdout);
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
      case "advisor": {
        const adv = a ? m.advisorOf(a) : null;
        if (!adv) return die("unknown workflow, or the advisor is disabled", 1);
        if (sub === "list") return say(adv.list().map((r) => ({ id: r.id, type: r.type, task: r.task, state: r.state, trigger: r.trigger, reason: r.reason })));
        if (sub === "ask") {
          const out = await adv.consult({ kind: "ask", question: argv.slice(3).join(" ") }, false);
          return say({ assessment: out.assessment, proposals: out.records.map((r) => ({ id: r.id, type: r.type, task: r.task, state: r.state, reason: r.reason })) });
        }
        if (sub === "apply") return say(await adv.applyProposed(b ?? "", OPERATOR.id));
        if (sub === "release") {
          adv.release(b ?? "", OPERATOR.id);
          return say({ ok: true });
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
