// The two implementations of AgentRunner that exist today.

import { randomUUID } from "node:crypto";
import { runTask } from "../agent/loop.ts";
import { taskPrompt } from "../agent/prompts.ts";
import type { AgentProfile } from "./profile.ts";
import type { ModelPort } from "../model/types.ts";
import type { ResearchSession } from "../research/session.ts";
import { treeDigest } from "../validation/snapshot.ts";
import type { AgentRunOutput, AgentRunRequest, AgentRunner } from "./port.ts";
import { runAgent } from "./runner.ts";
import type { LoopLimits } from "../agent/loop.ts";
import { unknownUsage, type UsageRecord } from "./usage.ts";
import { PROFILE_CLI_ADAPTER, type AgentAdapter } from "./adapter.ts";

// ---- cli-oneshot -----------------------------------------------------------------------------

export class CliOneShotRunner implements AgentRunner {
  readonly adapter: AgentAdapter["id"];
  readonly #cliAdapter: AgentAdapter;

  constructor(adapter: AgentAdapter = PROFILE_CLI_ADAPTER) {
    this.#cliAdapter = adapter;
    this.adapter = adapter.id;
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
    const r = await runAgent({
      profile: req.profile,
      prompt,
      workspaceRoot: req.workspaceRoot,
      runId: req.runId,
      taskId: t.taskId,
      journal: req.journal,
      generation: req.generation,
      adapter: this.#cliAdapter,
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
  readonly #modelFor: ((p: AgentProfile) => ModelPort | null) | undefined;
  /**
   * `modelFor` lets a profile carry its OWN endpoint (any OpenAI-compatible server): the same loop, the
   * same executor, a different brain. Returning null falls back to the shared model.
   */
  constructor(model: ModelPort, limits?: Partial<LoopLimits>, research?: ResearchSession, modelFor?: (p: AgentProfile) => ModelPort | null) {
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

    const r = await runTask(
      {
        model: this.#modelFor?.(req.profile) ?? this.#model,
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
        objective: req.task.objective + (req.extraPrompt ? `\n\n${req.extraPrompt}` : ""),
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
        skills: [],
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
