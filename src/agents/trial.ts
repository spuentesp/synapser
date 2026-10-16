// A one-agent trial on a bounded disposable copy. The detailed per-run journal is temporary;
// only a compact, auditable summary and the final text are retained on the server journal.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentProfile, adapterOf, validateProfile } from "./profile.ts";
import { AgentRunnerRegistry, runAndIntegrate } from "./port.ts";
import { CliOneShotRunner, NativeLoopRunner, nativeRoleUsesSystemModel } from "./adapters.ts";
import { CLAUDE_CODE_ADAPTER } from "./claude-code.ts";
import { CODEX_ADAPTER } from "./codex.ts";
import { KIMI_ADAPTER } from "./kimi.ts";
import { MIMO_ADAPTER } from "./mimo.ts";
import { GENERIC_CLI_ADAPTER } from "./generic-cli.ts";
import { Executor } from "../executor/executor.ts";
import { acquireWorkspaceLockInOrder, type WorkspaceLock } from "../journal/lock.ts";
import type { Journal } from "../journal/journal.ts";
import { modelConfigForProvider, type ProviderConfig, systemModelConfig } from "../model/config.ts";
import { BudgetManager } from "../model/budget.ts";
import { journalRecorder, priceResolverForProviders } from "../model/recorder.ts";
import { OpenAICompatibleProvider } from "../model/openai-compatible-provider.ts";
import type { Role as ModelRole } from "../model/types.ts";
import { libraryFetch } from "../model/destinations.ts";
import { runLibrary, type OperatorFile } from "../library/resolve.ts";
import type { LibraryStore } from "../library/store.ts";
import { loadPin } from "../zoo/pin.ts";
import { ZooAdapter } from "../zoo/adapter.ts";
import { listTree, takeSnapshot } from "../validation/snapshot.ts";
import { canonicalJson } from "../digest/canonical.ts";
import { sha256Bytes } from "../digest/file.ts";
import type { InjectedSkill } from "./adapter.ts";
import type { SynapserConfig } from "../config/load.ts";

const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_COPY_FILES = 8_000;
const MAX_TASK_CHARS = 500;
const MAX_TRIAL_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export class AgentTrialRequestError extends Error {
  constructor(message: string) { super(message); this.name = "AgentTrialRequestError"; }
}

export interface AgentTrialInput {
  task: string;
  timeLimitSeconds: number;
  maxBudgetUsd?: number;
}

export interface AgentTrialResult {
  trialId: string;
  profileId: string;
  outcome: string;
  output: string | null;
  reason: string | null;
  costUsd: number | null;
  durationMs: number;
  skills: { id: string; digest: string; mechanism: string; reason?: string }[];
  changedPaths: string[];
  networkIsolated: false;
}

export async function runAgentTrial(o: {
  cfg: SynapserConfig;
  library: LibraryStore;
  serverJournal: Journal;
  profileId: string;
  input: AgentTrialInput;
}): Promise<AgentTrialResult> {
  const { cfg, library, serverJournal, profileId, input } = o;
  validateInput(input);
  const trialId = `trial-${randomUUID()}`;
  const scratch = mkdtempSync(join(tmpdir(), "synapser-trial-"));
  const workspaceRoot = join(scratch, "workspace");
  const stateDir = join(scratch, "state");
  mkdirSync(workspaceRoot, { recursive: true });
  const journal = (await import("../journal/journal.ts")).Journal.open(stateDir, trialId);
  let lock: WorkspaceLock | undefined;
  let zoo: ZooAdapter | undefined;
  let result: AgentTrialResult | undefined;
  let profile: AgentProfile | undefined;
  let profileDigest = "";
  let sourceDigest = "";
  const startedAt = Date.now();
  try {
    const sourceFiles = listTree(cfg.workspace);
    if (sourceFiles.length > MAX_COPY_FILES) throw new Error(`workspace copy exceeds ${MAX_COPY_FILES} files`);
    const bytes = sourceFiles.reduce((total, path) => total + statSync(join(cfg.workspace, path)).size, 0);
    if (bytes > MAX_COPY_BYTES) throw new Error(`workspace copy exceeds ${MAX_COPY_BYTES} bytes`);
    const snapshot = takeSnapshot(cfg.workspace, workspaceRoot);
    if (!snapshot.consistent) throw new Error("workspace changed while the disposable trial copy was being made; retry the trial");
    sourceDigest = snapshot.digest;

    const frozen = library.freeze(journal);
    const operatorFile: OperatorFile = {
      providers: cfg.providers,
      profiles: cfg.profiles,
      providerKeyEnv: cfg.providerKeyEnv,
      agentSkills: cfg.agentSkills,
    };
    const view = runLibrary(operatorFile, frozen);
    profile = view.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new AgentTrialRequestError(`unknown agent ${profileId}`);
    if (!profile.enabled) throw new AgentTrialRequestError(`agent ${profileId} is disabled: ${profile.disabledReason ?? "no reason recorded"}`);
    const budget = input.maxBudgetUsd;
    if (budget !== undefined && adapterOf(profile) !== "claude-code") throw new AgentTrialRequestError("a dollar limit is supported only by claude-code");
    if (budget !== undefined && profile.maxBudgetUsd !== undefined && budget > profile.maxBudgetUsd) throw new AgentTrialRequestError(`dollar limit cannot exceed the profile limit of ${profile.maxBudgetUsd}`);
    profile = { ...profile, timeoutMs: Math.min(profile.timeoutMs, input.timeLimitSeconds * 1000), ...(budget !== undefined ? { maxBudgetUsd: budget } : {}) };
    const profileErrors = validateProfile(profile);
    if (profileErrors.length) throw new Error(profileErrors.join("; "));
    profileDigest = sha256Bytes(Buffer.from(canonicalJson(profile), "utf8"));

    lock = await acquireWorkspaceLockInOrder(stateDir, workspaceRoot, { timeoutMs: Math.min(input.timeLimitSeconds * 1000, 5_000) });
    zoo = await ZooAdapter.open(loadPin(), workspaceRoot);
    const executor = new Executor({ workspace: workspaceRoot, runId: trialId, journal, zoo, generation: lock.generation });
    const system = systemModelConfig(view.providers, cfg.roles);
    const timeLimitMs = input.timeLimitSeconds * 1000;
    const shared = new OpenAICompatibleProvider({ config: { ...system, timeoutMs: Math.min(system.timeoutMs, timeLimitMs) }, onCall: journalRecorder(journal, priceResolverForProviders(cfg.providers)) });
    const modelFor = (candidate: AgentProfile, role: ModelRole) => {
      if (nativeRoleUsesSystemModel(role) && candidate.role !== "advisor") return null;
      if (!candidate.provider || !candidate.model) throw new Error(`native agent ${candidate.id} is missing its provider or model`);
      const provider = view.providers[candidate.provider];
      if (!provider) throw new Error(`agent ${candidate.id} references unknown provider ${candidate.provider}`);
      if (provider.protocol !== "openai-compatible") throw new Error(`native agent ${candidate.id} needs an openai-compatible provider; ${candidate.provider} speaks ${provider.protocol}`);
      const modelConfig = modelConfigForProvider(candidate.provider, provider, candidate.model, candidate.temperature ?? 0);
      modelConfig.timeoutMs = Math.min(modelConfig.timeoutMs, timeLimitMs);
      return new OpenAICompatibleProvider({
        config: modelConfig,
        ...(!Object.hasOwn(cfg.providers, candidate.provider) ? { fetch: libraryFetch() } : {}),
        onCall: journalRecorder(journal, priceResolverForProviders(Object.hasOwn(cfg.providers, candidate.provider) ? { [candidate.provider]: provider } : {})),
      });
    };
    const operatorProviders = () => cfg.providers as Readonly<Record<string, ProviderConfig>>;
    const registry = new AgentRunnerRegistry([
      new NativeLoopRunner(shared, { maxSteps: 8, maxNoProgress: 2 }, undefined, modelFor),
      new CliOneShotRunner(undefined, operatorProviders),
      new CliOneShotRunner(GENERIC_CLI_ADAPTER, operatorProviders),
      new CliOneShotRunner(CLAUDE_CODE_ADAPTER, operatorProviders),
      new CliOneShotRunner(CODEX_ADAPTER, operatorProviders),
      new CliOneShotRunner(KIMI_ADAPTER, operatorProviders),
      new CliOneShotRunner(MIMO_ADAPTER, operatorProviders),
    ], { skillsFor: (id) => view.skillsFor.get(id) ?? [] });
    const dirs = readdirSync(workspaceRoot, { withFileTypes: true });
    const scope = dirs.flatMap((entry) => entry.isDirectory() ? [`${entry.name}/`] : entry.isFile() ? [entry.name] : []);
    const task = {
      taskId: trialId,
      objective: input.task,
      scope,
      criteria: ["Do the requested small trial task and briefly report what you changed."],
      planRevision: 1,
    };
    const step = await runAndIntegrate(registry, {
      profile,
      task,
      workspaceRoot,
      runId: trialId,
      journal,
      executor,
      generation: lock.generation,
      budget: adapterOf(profile) === "native" ? new BudgetManager({ maxTokens: 80_000, maxCalls: 16 }) : undefined,
      deadlineMs: Date.now() + timeLimitMs,
    });
    const callRows = journal.listModelCalls().filter((call) => call.taskId === trialId);
    const costs = callRows.map((call) => call.costUsd);
    const knownCost = costs.length && costs.every((cost) => cost !== null) ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0) : null;
    const usageCost = step.run.usage.costUsd;
    const costUsd = adapterOf(profile) === "native" ? knownCost : usageCost;
    result = {
      trialId,
      profileId,
      outcome: step.run.outcome,
      output: step.run.finalText === null ? null : clip(step.run.finalText, MAX_OUTPUT_CHARS),
      reason: step.run.reason ?? step.integration.detail,
      costUsd,
      durationMs: step.run.durationMs,
      skills: (step.run.integration.mode === "pending" ? step.run.integration.run.skills : journal.listAgentRuns().find((r) => r.agentRunId === step.run.agentRunId)?.skills ?? []) as AgentTrialResult["skills"],
      changedPaths: step.run.changedPaths,
      networkIsolated: false,
    };
  } catch (error) {
    if (error instanceof AgentTrialRequestError) throw error;
    const message = String((error as Error).message ?? error).slice(0, 400);
    result = {
      trialId, profileId, outcome: "FAILED", output: null, reason: message, costUsd: null,
      durationMs: Date.now() - startedAt, skills: [], changedPaths: [], networkIsolated: false,
    };
  } finally {
    await zoo?.close().catch(() => undefined);
    lock?.release();
    journal.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  const saved = result as AgentTrialResult;
  const outputBlob = saved.output === null ? null : serverJournal.artifacts.put(Buffer.from(saved.output, "utf8"));
  serverJournal.tx((tx) => tx.event("_server", "agent_trial", trialId, null, saved.outcome, {
    profileId,
    profileDigest,
    sourceDigest,
    timeLimitSeconds: input.timeLimitSeconds,
    ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    outcome: saved.outcome,
    reason: saved.reason,
    costUsd: saved.costUsd,
    durationMs: saved.durationMs,
    outputBlob,
    skills: saved.skills,
    changedPaths: saved.changedPaths,
    networkIsolated: false,
  }));
  return saved;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[trial output truncated]` : value;
}

function validateInput(input: AgentTrialInput): void {
  if (typeof input.task !== "string" || input.task.trim().length === 0 || input.task.length > MAX_TASK_CHARS || /[\r\n]/.test(input.task)) {
    throw new Error(`task must be one line of at most ${MAX_TASK_CHARS} characters`);
  }
  if (!Number.isInteger(input.timeLimitSeconds) || input.timeLimitSeconds < 10 || input.timeLimitSeconds * 1000 > MAX_TRIAL_MS) {
    throw new Error("timeLimitSeconds must be an integer from 10 to 600");
  }
  if (input.maxBudgetUsd !== undefined && (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0 || input.maxBudgetUsd > 1000)) {
    throw new Error("maxBudgetUsd must be greater than 0 and at most 1000");
  }
}
