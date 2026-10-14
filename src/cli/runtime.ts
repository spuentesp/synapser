// Wiring shared by the CLI and the MCP process: config → manager (with the production engine).

import { Advisor } from "../advisor/advisor.ts";
import { ChatService } from "../chat/chat.ts";
import { Journal } from "../journal/journal.ts";
import { type SynapserConfig } from "../config/load.ts";
import { journalRecorder, OpenAICompatibleProvider, systemModelConfig } from "../model/index.ts";
import { priceResolverForProviders } from "../model/recorder.ts";
import { buildCatalog, type ProfileCard } from "../orchestration/catalog.ts";
import { loadHistory } from "../orchestration/history.ts";
import { QueryGuard, researchFromEnv, ResearchSession } from "../research/index.ts";
import { ProductionEngine } from "../workflow/engine.ts";
import { WorkflowManager } from "../workflow/manager.ts";
import { LibraryStore } from "../library/store.ts";
import { liveSource, resolveLibrary } from "../library/resolve.ts";


export interface Runtime {
  manager: WorkflowManager;
  catalog: () => ProfileCard[];
  serverJournal: Journal;
  library: LibraryStore;
  chat: ChatService;
  close(): Promise<void>;
}

export function createRuntime(cfg: SynapserConfig): Runtime {
  const systemModels = systemModelConfig(cfg.providers, cfg.roles);
  const systemPrice = priceResolverForProviders(systemModels.providers);
  const engine = new ProductionEngine({
    workspaceRoot: cfg.workspace,
    stateDir: cfg.stateDir,
    commands: cfg.commands,
    profiles: cfg.profiles,
    providers: cfg.providers,
    providerKeyEnv: cfg.providerKeyEnv,
    agentSkills: cfg.agentSkills,
    models: (journal) => new OpenAICompatibleProvider({ config: systemModels, onCall: journalRecorder(journal, systemPrice) }),
    ...(cfg.research ? { research: (journal: Journal, runId: string) => new ResearchSession({ port: researchFromEnv(), journal, runId, guard: new QueryGuard(cfg.workspace) }) } : {}),
    knownUsdPerRun: cfg.knownUsdPerRun,
    history: (journal) => loadHistory(cfg.stateDir, journal.runId),
    pools: cfg.pools,
    limits: cfg.limits,
    delegation: cfg.delegation,
    ...(cfg.advisor.enabled ? { advisor: { enabled: true, pushback: cfg.advisor.pushback, maxConsults: cfg.advisor.maxConsults, maxPerTask: cfg.advisor.maxPerTask } } : {}),
  });
  const serverJournal = Journal.open(cfg.stateDir, "_server");
  const library = new LibraryStore(cfg.stateDir, serverJournal);
  // the profiles a person sees and may name now: the operator's file plus the library as it stands (runs read their snapshot)
  const liveProfiles = () => resolveLibrary({ providers: cfg.providers, profiles: cfg.profiles, providerKeyEnv: cfg.providerKeyEnv }, liveSource(library)).profiles;
  const manager = new WorkflowManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspace,
    commandIds: new Set(cfg.commands.map((c) => c.id)),
    profileIds: () => new Set(liveProfiles().map((p) => p.id)),
    engine,
    library,
    startRequiresApproval: cfg.startRequiresApproval,
    ...(cfg.advisor.enabled
      ? {
          advisor: (journal: Journal, id: string, workflow: () => import("../workflow/model.ts").Workflow) =>
            new Advisor({ journal, runId: id, model: new OpenAICompatibleProvider({ config: systemModels, onCall: journalRecorder(journal, systemPrice) }), workflow, limits: { maxConsults: cfg.advisor.maxConsults, maxPerTask: cfg.advisor.maxPerTask } }),
        }
      : {}),
    policy: () => cfg.policy,
    effectIdentity: cfg.identity,
  });
  const chat = new ChatService({
    model: new OpenAICompatibleProvider({ config: systemModels, onCall: journalRecorder(serverJournal, systemPrice) }),
    manager,
    journal: serverJournal,
    catalog: () => buildCatalog(liveProfiles(), [], { knownUsdPerRun: cfg.knownUsdPerRun }),
    commandIds: () => cfg.commands.map((c) => c.id),
    advise: async (workflowId, question) => {
      const adv = manager.advisorOf(workflowId);
      if (!adv) return null;
      const out = await adv.consult({ kind: "ask", question }, false);
      return { assessment: out.assessment, proposals: out.records.map((r) => ({ id: r.id, type: r.type, task: r.task, state: r.state, why: (r.body as { why?: string }).why ?? "" })) };
    },
  });
  return {
    manager,
    serverJournal,
    library,
    chat,
    catalog: () => buildCatalog(liveProfiles(), [], { knownUsdPerRun: cfg.knownUsdPerRun }),
    close: async () => {
      await manager.close();
      serverJournal.close();
    },
  };
}
