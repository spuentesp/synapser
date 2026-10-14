// Wiring shared by the CLI and the MCP process: config → manager (with the production engine).

import { Journal } from "../journal/journal.ts";
import { type SynapserConfig } from "../config/load.ts";
import { defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../model/index.ts";
import { buildCatalog, type ProfileCard } from "../orchestration/catalog.ts";
import { QueryGuard, researchFromEnv, ResearchSession } from "../research/index.ts";
import { ProductionEngine } from "../workflow/engine.ts";
import { WorkflowManager } from "../workflow/manager.ts";


export interface Runtime {
  manager: WorkflowManager;
  catalog: () => ProfileCard[];
  serverJournal: Journal;
  close(): Promise<void>;
}

export function createRuntime(cfg: SynapserConfig): Runtime {
  const engine = new ProductionEngine({
    workspaceRoot: cfg.workspace,
    stateDir: cfg.stateDir,
    commands: cfg.commands,
    profiles: cfg.profiles,
    models: (journal) => new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) }),
    ...(cfg.research ? { research: (journal: Journal, runId: string) => new ResearchSession({ port: researchFromEnv(), journal, runId, guard: new QueryGuard(cfg.workspace) }) } : {}),
    knownUsdPerRun: cfg.knownUsdPerRun,
    limits: cfg.limits,
    delegation: cfg.delegation,
  });
  const manager = new WorkflowManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspace,
    commandIds: new Set(cfg.commands.map((c) => c.id)),
    profileIds: new Set(cfg.profiles.map((p) => p.id)),
    engine,
    startRequiresApproval: cfg.startRequiresApproval,
  });
  const serverJournal = Journal.open(cfg.stateDir, "_server");
  return {
    manager,
    serverJournal,
    catalog: () => buildCatalog(cfg.profiles, [], { knownUsdPerRun: cfg.knownUsdPerRun }),
    close: async () => {
      await manager.close();
      serverJournal.close();
    },
  };
}
