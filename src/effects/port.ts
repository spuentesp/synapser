// What an agent loop (or MCP tool) can do about effects: ask, and look. Never perform, never approve.
export interface EffectPort {
  request(r: { kind: string; params: unknown; requestedBy: string; taskId?: string | null; role?: string | null }): Promise<
    | { ok: true; id: string; state: string; decision: string; summary: string; rule: string | null }
    | { ok: false; code: string; errors?: string[] }
  >;
  status(id: string): { id: string; kind: string; state: string; summary: string; reason: string | null; evidence: Record<string, unknown> | null } | null;
}
