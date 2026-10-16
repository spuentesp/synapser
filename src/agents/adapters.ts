// The two implementations of AgentRunner that exist today.

import { randomUUID } from "node:crypto";
import { runTask } from "./native/loop.ts";
import { taskPrompt } from "./native/prompts.ts";
import type { AgentProfile } from "./profile.ts";
import type { ModelPort, Role as ModelRole } from "../model/types.ts";
import type { ResearchSession } from "../research/session.ts";
import { treeDigest } from "../validation/snapshot.ts";
import type { AgentRunOutput, AgentRunRequest, AgentRunner } from "./port.ts";
import { runAgent } from "./runner.ts";
import type { LoopLimits } from "./native/loop.ts";
import { unknownUsage, type UsageRecord } from "./usage.ts";
import { PROFILE_CLI_ADAPTER, type AgentAdapter } from "./adapter.ts";
import { prependSkills, validateInjectedSkills } from "./skills.ts";
import { type InjectedProvider, providerForRun } from "./inject.ts";
import type { ProviderConfig } from "../model/config.ts";

/** Worker and repair are system roles, so their configured assignments take precedence over native profile providers. */
export function nativeRoleUsesSystemModel(role: ModelRole): boolean {
  return role === "worker" || role === "repair";
}

// ---- cli-oneshot -----------------------------------------------------------------------------

export class CliOneShotRunner implements AgentRunner {
  readonly adapter: AgentAdapter["id"];
  readonly #cliAdapter: AgentAdapter;

  readonly #providers: (() => Readonly<Record<string, ProviderConfig>>) | undefined;

  /** `providers` is the operator's provider table; without it a profile that asks for an injection is refused. */
  constructor(adapter: AgentAdapter = PROFILE_CLI_ADAPTER, providers?: () => Readonly<Record<string, ProviderConfig>>) {
    this.#cliAdapter = adapter;
    this.adapter = adapter.id;
    this.#providers = providers;
  }

  async run(req: AgentRunRequest): Promise<AgentRunOutput> {
    const t = req.task;
    const prompt =
      [
        taskPrompt({ objective: t.objective, scope: t.scope, criteria: t.criteria, ...(t.context ? { context: t.context } : {}) }).replace(
          "Start by reading the files you need.",
          "Edit ONLY the scope files. Do not create other files. When done, reply with one short sentence.",
        ),
        req.extraPrompt ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
    // Plan 17 P17.6: an injection request is resolved against the operator's providers, and refused without them.
    let provider: InjectedProvider | undefined;
    if (req.profile.injectProvider !== undefined) {
      if (!this.#providers) throw new Error(`${req.profile.id}: injectProvider needs the operator's providers, and none were given`);
      provider = providerForRun(req.profile.id, req.profile.injectProvider, req.profile.model ?? "", this.#providers(), process.env);
    }
    const r = await runAgent({
      profile: req.profile,
      prompt,
      workspaceRoot: req.workspaceRoot,
      ...(provider ? { provider } : {}),
      runId: req.runId,
      taskId: t.taskId,
      journal: req.journal,
      generation: req.generation,
      adapter: this.#cliAdapter,
      ...(req.injectedSkills ? { injectedSkills: req.injectedSkills } : {}),
    });
    return {
      agentRunId: r.agentRunId,
      profileId: r.profileId,
      adapter: this.adapter,
      role: r.role,
      outcome: r.outcome,
      reason: r.reason,
      durationMs: r.durationMs,
      usage: r.usage,
      toolUse: r.toolUse,
      sessionId: r.sessionId,
      finalText: r.finalText,
      changedPaths: r.changes.map((c) => c.path),
      integration: { mode: "pending", run: r },
    };
  }
}

// ---- native (Nemotron loop on Token Factory) -------------------------------------------------

export class NativeLoopRunner implements AgentRunner {
  readonly adapter = "native" as const;
  readonly #model: ModelPort;
  readonly #limits: Partial<LoopLimits> | undefined;
  readonly #research: ResearchSession | undefined;
  readonly #modelFor: ((p: AgentProfile, role: ModelRole) => ModelPort | null) | undefined;
  /**
   * `modelFor` lets a profile carry its OWN endpoint (any OpenAI-compatible server): the same loop, the
   * same executor, a different brain. It receives the effective role so callers can defer system-routed
   * calls to the role-aware shared model. Returning null falls back to the shared model.
   */
  constructor(model: ModelPort, limits?: Partial<LoopLimits>, research?: ResearchSession, modelFor?: (p: AgentProfile, role: ModelRole) => ModelPort | null) {
    this.#model = model;
    this.#limits = limits;
    this.#research = research;
    this.#modelFor = modelFor;
  }

  async run(req: AgentRunRequest): Promise<AgentRunOutput> {
    const { journal } = req;
    const startedAt = Date.now();
    const agentRunId = `ar-${randomUUID()}`;
    const before = new Set(journal.listModelCalls().map((c) => c.callId));
    const baseDigest = treeDigest(req.workspaceRoot);
    const role = req.profile.nativeRole ?? "worker";

    // plan 14 Q5.4: library skills reach the native loop by prompt-prepend; their provenance and digests are checked first (L1)
    const injected = req.injectedSkills ?? { skills: [] };
    const skills = validateInjectedSkills(injected, "prompt-prepend");
    const r = await runTask(
      {
        model: this.#modelFor?.(req.profile, role) ?? this.#model,
        executor: req.executor,
        journal,
        runId: req.runId,
        ...(req.budget ? { budget: req.budget } : {}),
        role,
        ...(req.deadlineMs !== undefined ? { deadlineMs: req.deadlineMs } : {}),
        ...(this.#limits ? { limits: this.#limits } : {}),
        ...(this.#research ? { research: this.#research } : {}),
        ...(req.delegation ? { delegation: req.delegation } : {}),
        ...(req.effects ? { effects: req.effects } : {}),
        ...(req.control ? { control: req.control } : {}),
      },
      {
        taskId: req.task.taskId,
        objective: prependSkills(req.task.objective + (req.extraPrompt ? `\n\n${req.extraPrompt}` : ""), injected.skills),
        scope: req.task.scope,
        criteria: req.task.criteria,
        ...(req.task.context ? { context: req.task.context } : {}),
        planRevision: req.task.planRevision,
      },
    );

    // Usage comes from the model_calls this run made: exact, recorded by the provider.
    // attributed by TASK as well as role: concurrent tasks share a role and must not share a bill
    const calls = journal.listModelCalls().filter((c) => !before.has(c.callId) && c.role === role && c.taskId === req.task.taskId);
    const sum = (f: (c: (typeof calls)[number]) => number | null) => calls.reduce((a, c) => a + (f(c) ?? 0), 0);
    const anyUnpriced = calls.some((c) => c.costUsd === null);
    const usage: UsageRecord = calls.length
      ? {
          provenance: "reported",
          inputTokens: sum((c) => c.promptTokens),
          outputTokens: sum((c) => c.completionTokens),
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          costUsd: anyUnpriced ? null : sum((c) => c.costUsd),
          models: [...new Set(calls.map((c) => c.servedModel ?? c.requestedModel))],
          turns: calls.length,
          apiMs: null,
          note: anyUnpriced ? "some calls used a model without a price in the table" : "estimated from the price table",
        }
      : unknownUsage("no model calls were recorded");

    const outcome = r.status === "FINISHED" ? "SUCCEEDED" : "FAILED";
    const reason = r.status === "FINISHED" ? null : `${r.status}${r.detail ? `: ${r.detail}` : ""}`;
    const applied = r.actions.filter((a) => a.status === "SETTLED" || a.status === "APPLIED");
    const changedPaths = [...new Set(applied.flatMap((a) => journal.getActionFiles(a.actionId).map((f) => f.path)))].sort();
    const durationMs = Date.now() - startedAt;
    const toolUse: Record<string, number> = {};
    for (const e of journal.listEvents()) {
      if (e.entity === "agent_step" && e.entityId === req.task.taskId && e.seq > 0) {
        const tool = (e.data as { tool?: string | null }).tool;
        if (tool) toolUse[tool] = (toolUse[tool] ?? 0) + 1;
      }
    }

    journal.tx((t) =>
      t.insertAgentRun({
        agentRunId, runId: req.runId, taskId: req.task.taskId, profileId: req.profile.id, role: req.profile.role, adapter: this.adapter,
        startedAt, finishedAt: Date.now(), durationMs, argv: [], baseDigest, exitCode: null, signal: null, timedOut: false,
        outcome, reason, sessionId: null, models: usage.models, usageProvenance: usage.provenance, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: usage.costUsd,
        turns: usage.turns, apiMs: null, networkIsolated: false, permissionDenials: null,
        promptBlob: null, stdoutBlob: null, stderrBlob: null, finalTextBlob: null,
        toolUse: Object.keys(toolUse).length ? toolUse : null,
        skills,
        changes: applied.flatMap((a) => journal.getActionFiles(a.actionId).map((f) => ({ path: f.path, op: f.op, beforeDigest: f.beforeDigest, afterDigest: f.afterDigest }))),
      }),
    );

    return {
      agentRunId, profileId: req.profile.id, adapter: this.adapter, role: req.profile.role, outcome, reason, durationMs, usage,
      toolUse: Object.keys(toolUse).length ? toolUse : null, sessionId: null, finalText: r.summary, changedPaths,
      integration: { mode: "direct", actions: r.actions },
    };
  }
}
