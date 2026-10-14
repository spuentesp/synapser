import { useCallback, useEffect, useRef, useState } from 'react'
import { api, runPath, type RunInfo, type SwarmState } from '@/lib/api'

export interface Ledger {
  runs: RunInfo[]
  run: RunInfo | null
  runId: string | null
  setRunId: (id: string) => void
  state: SwarmState | null
  head: number
  /** Replay position; null = follow the head. */
  seq: number | null
  setSeq: (s: number | null) => void
  live: boolean
  /** The page has the session cookie (plan 15 D1). */
  session: boolean
  /** Adversarial mode: the one-time code is needed before anything works (plan 15 D7). */
  needsCode: boolean
  refreshSession: () => void
  refresh: () => Promise<void>
  /** Bumps whenever the ledger grew, so views can re-fetch. */
  tick: number
  error: string | null
  /** True once the run list has been read at least once: an empty list is then a real answer, not a loading state. */
  loaded: boolean
}

/** One source of truth for the page: runs, the swarm state, and the live SSE stream. */
export function useLedger(): Ledger {
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [runId, setRunIdState] = useState<string | null>(null)
  const [state, setState] = useState<SwarmState | null>(null)
  const [seq, setSeq] = useState<number | null>(null)
  const [session, setSession] = useState(false)
  const [needsCode, setNeedsCode] = useState(false)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const headRef = useRef(0)
  const [head, setHead] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const { runs: rs } = await api<{ runs: RunInfo[] }>('/api/runs')
      setRuns(rs)
      setLoaded(true)
      const id = runId && rs.some((r) => r.id === runId) ? runId : (rs.at(-1)?.id ?? null)
      if (id !== runId) setRunIdState(id)
      if (id) {
        const st = await api<SwarmState>(runPath(id, `/state${seq ? `?seq=${seq}` : ''}`))
        setState(st)
        const ev = rs.find((r) => r.id === id)?.events ?? st.atSeq
        headRef.current = ev
        setHead(ev)
      }
      setError(null)
      setTick((n) => n + 1)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [runId, seq])

  // the session is a cookie the server sets; the page learns only whether it has one (plan 15 D1)
  const refreshSession = useCallback(() => {
    api<{ ok: boolean; needsCode?: boolean }>('/api/session').then((s) => { setSession(s.ok); setNeedsCode(Boolean(s.needsCode)) }).catch(() => {})
  }, [])
  useEffect(() => {
    refreshSession()
  }, [refreshSession])
  useEffect(() => {
    void refresh()
  }, [refresh])

  // live stream: any ledger event schedules a (debounced) refresh while following the head
  useEffect(() => {
    if (!runId) return
    const es = new EventSource(runPath(runId, `/events?since=${headRef.current}`))
    let timer: ReturnType<typeof setTimeout> | undefined
    es.addEventListener('ledger', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as { seq: number }
      headRef.current = Math.max(headRef.current, ev.seq)
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 150)
    })
    return () => {
      clearTimeout(timer)
      es.close()
    }
  }, [runId, refresh])

  const setRunId = useCallback((id: string) => {
    setSeq(null)
    setState(null)
    setRunIdState(id)
  }, [])

  return {
    runs, run: runs.find((r) => r.id === runId) ?? null, runId, setRunId, state, head, seq, setSeq,
    live: seq === null, session, needsCode, refreshSession, refresh, tick, error, loaded,
  }
}
