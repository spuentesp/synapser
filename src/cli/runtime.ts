// Wiring shared by the CLI and the MCP process: config → manager (with the production engine).

import { Advisor } from "../advisor/advisor.ts";
import { Journal } from "../journal/journal.ts";
import { type SynapserConfig } from "../config/load.ts";
import { defaultModelConfig, journalRecorder, OpenAICompatibleProvider } from "../model/index.ts";
import { buildCatalog, type ProfileCard } from "../orchestration/catalog.ts";
import { loadHistory } from "../orchestration/history.ts";
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
    history: (journal) => loadHistory(cfg.stateDir, journal.runId),
    pools: cfg.pools,
    limits: cfg.limits,
    delegation: cfg.delegation,
    ...(cfg.advisor.enabled ? { advisor: { enabled: true, pushback: cfg.advisor.pushback, maxConsults: cfg.advisor.maxConsults, maxPerTask: cfg.advisor.maxPerTask } } : {}),
  });
  const manager = new WorkflowManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspace,
    commandIds: new Set(cfg.commands.map((c) => c.id)),
    profileIds: new Set(cfg.profiles.map((p) => p.id)),
    engine,
    startRequiresApproval: cfg.startRequiresApproval,
    ...(cfg.advisor.enabled
      ? {
          advisor: (journal: Journal, id: string, workflow: () => import("../workflow/model.ts").Workflow) =>
            new Advisor({ journal, runId: id, model: new OpenAICompatibleProvider({ config: defaultModelConfig(), onCall: journalRecorder(journal) }), workflow, limits: { maxConsults: cfg.advisor.maxConsults, maxPerTask: cfg.advisor.maxPerTask } }),
        }
      : {}),
    policy: () => cfg.policy,
    effectIdentity: cfg.identity,
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
