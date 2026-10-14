// The operator's first screen (plan 14 Q4.1): what is active, what waits for a person, which agents are enabled, and
// what the runs have cost. Every empty card says what to do next and links to the place that does it (Q4.2).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Empty, ErrorNote } from './common'

interface Home {
  workflows: { total: number; active: { id: string; title: string; state: string; revision: number }[] }
  pendingApprovals: number
  runsWaiting: string[]
  agents: { total: number; enabled: number }
  cost: { knownUsd: number; unknownRuns: number; agentRuns: number }
  runs: number
}

const STATE_TONE: Record<string, string> = { RUNNING: 'text-status-running', AWAITING_START: 'text-status-waiting', PLANNING: 'text-status-running', VERIFYING: 'text-status-running' }

export function HomeView({ onNavigate, onOpenRun }: { onNavigate: (view: 'workflows' | 'agents' | 'library') => void; onOpenRun: (runId: string) => void }) {
  const { t } = useI18n()
  const [home, setHome] = useState<Home | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => api<Home>('/api/home').then((h) => { if (alive) { setHome(h); setErr(null) } }, (e: Error) => { if (alive) setErr(e.message) })
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (err) return <ErrorNote code={err} />
  if (!home) return null
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('homeActive')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {home.workflows.active.length === 0 ? (
            <Empty>
              <span className="block">{t('homeNoneActive')}</span>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => onNavigate('workflows')}>{t('homeCreate')}</Button>
            </Empty>
          ) : (
            <ul className="grid gap-2">
              {home.workflows.active.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => onNavigate('workflows')} className="flex w-full flex-wrap items-center gap-2 rounded-lg border p-2.5 text-left hover:bg-muted">
                    <span className="font-medium">{w.title}</span>
                    <Badge variant="outline" className={cn('text-[10px]', STATE_TONE[w.state])}>{w.state}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('homePending')}
            {home.pendingApprovals > 0 ? <Badge>{home.pendingApprovals}</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {home.pendingApprovals === 0 ? (
            <Empty>{t('homeNoPending')}</Empty>
          ) : (
            <>
              <p>{home.pendingApprovals} {t('homeWaiting')}: <span className="font-mono text-xs">{home.runsWaiting.join(', ')}</span></p>
              <div>
                <Button size="sm" onClick={() => onOpenRun(home.runsWaiting[0] ?? '')}>{t('approvals')}</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('homeAgents')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {home.agents.total === 0 ? (
            <Empty>
              <span className="block">{t('homeNoAgents')}</span>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => onNavigate('library')}>{t('library')}</Button>
            </Empty>
          ) : (
            <p>{home.agents.enabled} {t('homeAgentsOf')} {home.agents.total}</p>
          )}
          <div>
            <Button size="sm" variant="outline" onClick={() => onNavigate('agents')}>{t('agents')}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('homeCost')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {home.cost.agentRuns === 0 && home.cost.knownUsd === 0 ? (
            <Empty>{t('homeNoCalls')}</Empty>
          ) : (
            <>
              <p className="text-2xl font-semibold tabular-nums">${home.cost.knownUsd.toFixed(4)}</p>
              <p className="text-xs text-muted-foreground">{home.cost.agentRuns} {t('homeCalls')} · {home.runs} {t('allRuns')}</p>
              {home.cost.unknownRuns > 0 ? <p className="text-xs text-status-waiting">{home.cost.unknownRuns} {t('homeCostUnknown')}</p> : null}
              <p className="text-xs text-muted-foreground">{t('homeCostScope')}</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
