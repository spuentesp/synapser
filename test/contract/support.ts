// Plan 18 E2: shared support for the contract snapshots. The script that regenerates them and the tests that compare
// them build the same objects, so a snapshot cannot drift from what the test reads.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../src/journal/journal.ts";
import { McpServer } from "../../src/mcp/server.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

const RUN = "run-contract";

/** The task connector's tool list, as a client receives it from tools/list. */
export async function taskToolList(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
  const state = mkdtempSync(join(tmpdir(), "contract-state-"));
  const ws = mkdtempSync(join(tmpdir(), "contract-ws-"));
  const sj = Journal.open(state, "_server");
  const mgr = new WorkflowManager({ stateDir: state, workspaceRoot: ws, commandIds: new Set(), profileIds: new Set(), pollMs: 20, engine: { run: async () => ({ status: "DONE", reason: null }) } });
  try {
    const srv = new McpServer({ manager: mgr, serverJournal: sj });
    const r = (await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; description?: string; inputSchema?: unknown }[] } };
    return JSON.parse(JSON.stringify(r.result.tools));
  } finally {
    await mgr.close();
    sj.close();
    for (const d of [state, ws]) rmSync(d, { recursive: true, force: true });
  }
}

/** The column names of agent_runs in a freshly migrated journal, in table order. */
export function agentRunsColumns(): string[] {
  const state = mkdtempSync(join(tmpdir(), "contract-ledger-"));
  const j = Journal.open(state, RUN);
  j.close();
  try {
    const db = new DatabaseSync(join(state, RUN, "journal.db"));
    try {
      return (db.prepare("PRAGMA table_info(agent_runs)").all() as { name: string }[]).map((c) => c.name);
    } finally {
      db.close();
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

