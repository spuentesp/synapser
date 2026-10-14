import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CornerDownRight, Hourglass, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BORDER, StatusBadge } from '@/components/status-badge'
import { Cite } from '@/components/evidence'
import { cn } from '@/lib/utils'
import { fmtTokens, fmtUsd } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { AgentState, SwarmState } from '@/lib/api'

function AgentCard({ a, runId, refCb }: { a: AgentState; runId: string; refCb: (el: HTMLElement | null) => void }) {
  const { t } = useI18n()
  const tokens = a.runs.inputTokens + a.runs.outputTokens || a.modelCalls.promptTokens + a.modelCalls.completionTokens
  const usd = a.runs.usd || a.modelCalls.usd
  const unknown = a.runs.usdUnknownRuns + a.modelCalls.unpricedCalls
  return (
    <Card
      ref={refCb as never}
      data-testid="agent-card"
      data-task={a.taskId}
      className={cn('gap-3 border-l-4 py-3', BORDER[a.status])}
    >
      <CardHeader className="px-4">
        <CardTitle className="break-all">{a.taskId}</CardTitle>
        <CardAction>
          <StatusBadge status={a.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-4">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {a.profile ? <b className="font-semibold text-foreground">{a.profile}</b> : null}
          {a.kind ? <span>{a.kind}</span> : null}
          {a.requestedBy ? (
            <span className="inline-flex items-center gap-1">
              <CornerDownRight className="size-3" />
              {a.requestedBy} · d{a.depth}
            </span>
          ) : null}
        </div>
        {a.waitingOn ? (
          <div className="flex items-start gap-2 rounded-md border border-status-waiting/40 bg-status-waiting/10 px-2.5 py-1.5 text-xs">
            <Hourglass className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
            <span>
              {t('waitingOn')} <b>{a.waitingOn.holder.split(':').pop()}</b> · <code className="font-mono">{a.waitingOn.path}</code>
            </span>
          </div>
        ) : null}
        {a.heldFiles.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Lock className="size-3 text-muted-foreground" />
            {a.heldFiles.map((f) => (
              <Badge key={f} variant="outline" className="font-mono text-primary">{f}</Badge>
            ))}
          </div>
        ) : null}
        {a.observedHeld.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t('observed')}</span>
            {a.observedHeld.map((f) => (
              <Badge key={f} variant="outline" className="border-dashed font-mono">{f}</Badge>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><b className="text-foreground">{a.steps}</b> {t('steps')}</span>
          {tokens ? <span><b className="text-foreground">{fmtTokens(tokens)}</b> {t('tokens')}</span> : null}
          {usd || unknown ? (
            <span title={t('unknownNote')}>
              {usd ? <b className="text-foreground">{fmtUsd(usd)}</b> : <><b className="text-foreground">?</b> {t('unknownCost')}</>}
              {usd && unknown ? ` + ${unknown}×?` : ''}
            </span>
          ) : null}
          {a.searches ? <span><b className="text-foreground">{a.searches}</b> {t('searches')}</span> : null}
        </div>
        <Cite runId={runId} evidence={a.evidence} />
      </CardContent>
    </Card>
  )
}

export function SwarmView({ state, runId }: { state: SwarmState; runId: string }) {
  const { t } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const [paths, setPaths] = useState<string[]>([])

  const columns = useMemo(() => {
    const by = new Map(state.agents.map((a) => [a.taskId, a]))
    const lvl = new Map<string, number>()
    const level = (id: string, seen: Set<string> = new Set()): number => {
      const hit = lvl.get(id)
      if (hit !== undefined) return hit
      if (seen.has(id)) return 0
      seen.add(id)
      const deps = (by.get(id)?.deps ?? []).filter((d) => by.has(d))
      const l = deps.length ? 1 + Math.max(...deps.map((d) => level(d, seen))) : 0
      lvl.set(id, l)
      return l
    }
    state.agents.forEach((a) => level(a.taskId))
    const cols: AgentState[][] = Array.from({ length: Math.max(0, ...lvl.values()) + 1 }, () => [])
    state.agents.forEach((a) => cols[lvl.get(a.taskId) ?? 0]?.push(a))
    return cols
  }, [state.agents])

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const draw = () => {
      const box = el.getBoundingClientRect()
      const out: string[] = []
      for (const a of state.agents) {
        if (a.taskId === 'validate' || a.taskId.startsWith('validate-')) continue // acceptance waits for everything: implied
        const to = nodes.current.get(a.taskId)?.getBoundingClientRect()
        for (const d of a.deps) {
          const from = nodes.current.get(d)?.getBoundingClientRect()
          if (!from || !to) continue
          const x1 = from.right - box.left
          const y1 = from.top - box.top + from.height / 2
          const x2 = to.left - box.left
          const y2 = to.top - box.top + to.height / 2
          const mx = (x1 + x2) / 2
          out.push(`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`)
        }
      }
      setPaths(out)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [state.agents, columns])

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {state.alerts.length ? <Badge variant="outline"><AlertTriangle data-icon="inline-start" />{state.alerts.length} {t('alerts')}</Badge> : null}
        {state.zoo.gaps ? <Badge variant="outline">∅ {state.zoo.gaps} {t('gaps')}</Badge> : null}
        {state.delegations.accepted || state.delegations.rejected ? (
          <Badge variant="outline"><CornerDownRight data-icon="inline-start" />{state.delegations.accepted}/{state.delegations.rejected} {t('delegations')}</Badge>
        ) : null}
      </div>
      <div ref={wrap} className="relative grid items-start gap-10" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(230px, 1fr))` }}>
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
          {paths.map((d, i) => (
            <path key={i} d={d} fill="none" strokeWidth={1.6} className="stroke-border" />
          ))}
        </svg>
        {columns.map((col, i) => (
          <div key={i} className="grid content-start gap-3.5">
            {col.map((a) => (
              <AgentCard key={a.taskId} a={a} runId={runId} refCb={(el) => (el ? nodes.current.set(a.taskId, el) : nodes.current.delete(a.taskId))} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
