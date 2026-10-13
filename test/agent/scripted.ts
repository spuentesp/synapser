// A ModelPort whose answers are decided by a function. It behaves like the real provider where
// the loop can observe it: it honors the budget, never returns reasoning inside the assistant
// message, and records what the loop sent so tests can assert on it.

import { ModelError, type ChatMessage, type ModelPort, type ModelRequest, type ModelResponse, type ParsedToolCall, type CallContext } from "../../src/model/types.ts";

export const call = (name: string, args: unknown): ParsedToolCall => ({
  id: `call_${Math.random().toString(36).slice(2, 10)}`,
  name,
  argumentsRaw: JSON.stringify(args),
  args,
  argsValid: true,
});
export const rawCall = (name: string, argumentsRaw: string): ParsedToolCall => ({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, argumentsRaw, args: null, argsValid: false });

export type Decision = { calls?: ParsedToolCall[]; content?: string; throws?: ModelError };

export class ScriptedModel implements ModelPort {
  readonly seen: ChatMessage[][] = [];
  readonly requests: { role: string; hasSchema: boolean; hasTools: boolean }[] = [];
  #n = 0;
  readonly #decide: (messages: ChatMessage[], n: number, info: { role: string }) => Decision | Promise<Decision>;
  constructor(decide: (messages: ChatMessage[], n: number, info: { role: string }) => Decision | Promise<Decision>) {
    this.#decide = decide;
  }
  get calls(): number {
    return this.#n;
  }

  async complete(req: ModelRequest, ctx: CallContext): Promise<ModelResponse> {
    ctx.budget?.reserve(req.maxTokens);
    this.seen.push(JSON.parse(JSON.stringify(req.messages)));
    const n = ++this.#n;
    this.requests.push({ role: req.role, hasSchema: !!req.responseSchema, hasTools: !!req.tools?.length });
    const d = await this.#decide(req.messages, n, { role: req.role });
    if (d.throws) throw d.throws;
    ctx.budget?.record({ promptTokens: 10, completionTokens: 10 });
    const calls = d.calls ?? [];
    return {
      content: d.content ?? null,
      toolCalls: calls,
      reasoning: "SECRET-REASONING: private chain of thought",
      assistantMessage: {
        role: "assistant",
        content: d.content ?? null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.argumentsRaw } })) }
          : {}),
      },
      finishReason: calls.length ? "tool_calls" : "stop",
      usage: { promptTokens: 10, completionTokens: 10, reasoningTokens: 5 },
      requestedModel: "scripted",
      servedModel: "scripted",
      fallbackUsed: false,
      latencyMs: 1,
      retries: 0,
      rateLimit: {},
      callId: `mc-${n}`,
    };
  }
}

/** Parse the last tool message of a transcript. */
export function lastTool(messages: ChatMessage[]): any {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") {
      try {
        return JSON.parse(m.content ?? "null");
      } catch {
        return { _unparsed: m.content };
      }
    }
  }
  return null;
}
export const toolMessages = (messages: ChatMessage[]) => messages.filter((m) => m.role === "tool").length;
