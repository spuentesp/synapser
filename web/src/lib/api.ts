// Typed client for the Synapser API (src/api/server.ts). Every aggregate carries its evidence:
// the ledger seqs behind the figure (invariant U2), which the UI turns into a citation.

export interface Evidence {
  seqs: number[]
  total: number
}

export type AgentStatus =
  | 'planned' | 'waiting_approval' | 'ready' | 'running' | 'waiting' | 'validating' | 'done' | 'failed' | 'cancelled'

export interface AgentState {
  taskId: string
  status: AgentStatus
  profile: string | null
  kind: string | null
  depth: number
  requestedBy: string | null
  deps: string[]
  steps: number
  tools: Record<string, number>
  lastSeq: number
  currentAction: { actionId: string; state: string } | null
  waitingOn: { holder: string; path: string; sinceSeq: number } | null
  heldFiles: string[]
  observedHeld: string[]
  runs: { n: number; inputTokens: number; outputTokens: number; usd: number; usdUnknownRuns: number }
  modelCalls: { n: number; promptTokens: number; completionTokens: number; usd: number; unpricedCalls: number }
  searches: number
  evidence: Evidence
}

export interface SwarmState {
  atSeq: number
  mission: { state: string | null; planRevision: number }
  agents: AgentState[]
  pendingApprovals: string[]
  gates: { key: string; kind: 'start' | 'step' | 'condition' | 'effect' | 'intervention'; digest: string; summary: string; seq: number }[]
  alerts: { taskId: string; code: string; profile: string | null }[]
  zoo: { observations: number; gaps: number }
  delegations: { accepted: number; rejected: number }
  planDigest: string
}

export interface RunInfo {
  id: string
  state: string | null
  events: number
  head: string
  chainOk: boolean
  tasks: number
  pendingApprovals: number
}

export interface TimelineEntry {
  seq: number
  ts: number
  kind: string
  id: string
  from: string | null
  to: string | null
  summary: string
}

export interface CostRow {
  key: string
  runs: number
  succeeded: number
  inputTokens: number
  outputTokens: number
  usd: number
  usdKnownRuns: number
  usdUnknownRuns: number
  tokensUnknownRuns: number
  durationMs: number
  evidence: Evidence
}
export interface CostReport {
  by: string
  rows: CostRow[]
}
export interface WasteReport {
  totalRuns: number
  wastedRuns: { id: string; profile: string; why: string; usd: number | null; evidence: Evidence }[]
  wasteRatio: number | null
  wastedUsd: number
}
export interface CoordinationReport {
  rows: { taskId: string; actions: number; waits: number; waitMs: number; staleViews: number; recoveries: number; evidence: Evidence }[]
}
export interface VerifyReport {
  ok: boolean
  events: number
  head: string
  firstBadSeq: number | null
  reason: string | null
}
export interface ActionRow {
  actionId: string
  taskId: string
  state: string
  files: string[]
}
export interface WhyReport {
  found: boolean
  actionId: string
  mission: { objective: string; state: string } | null
  task: { id: string; objective: string; criteria: string[]; scope: string[]; deps: string[]; state: string } | null
  linkedBy: string | null
  agentRuns: {
    id: string; profile: string; adapter: string; role: string; outcome: string; durationMs: number
    usage: { provenance: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
  }[]
  action: {
    state: string
    files: { path: string; op: string; beforeDigest: string | null; afterDigest: string | null }[]
    transitions: { seq: number; ts: number; from: string | null; to: string | null; errorCode: string | null }[]
  } | null
  asserted: { seq: number; source: string; text: string }[]
  validations: { id: string; command: string; exitCode: number | null; valid: boolean; snapshotDigest: string }[]
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Every problem the server listed for a refused document (empty for other errors). */
  readonly errors: string[]
  constructor(status: number, code: string, errors: string[] = []) {
    super(code)
    this.status = status
    this.code = code
    this.errors = errors
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  const body = (await r.json().catch(() => ({}))) as { error?: string; errors?: string[] }
  if (!r.ok) throw new ApiError(r.status, body.error ?? r.statusText, Array.isArray(body.errors) ? body.errors : [])
  return body as T
}

export const runPath = (runId: string, p: string): string => `/api/runs/${encodeURIComponent(runId)}${p}`
