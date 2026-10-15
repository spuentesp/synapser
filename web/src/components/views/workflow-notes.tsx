// What the advisor proposed and which effects were requested for one workflow (plan 14 Q4.4). Read-only: the decisions are
// taken in Approvals, by a person, on the ledger.
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Empty } from './common'

interface Intervention {
  id: string
  type: string
  task: string
  state: string
  trigger: string
  reason: string
}

interface Effect {
  id: string
  kind: string
  state: string
  summary: string
  rule: string
  evidence: string | null
}

export function WorkflowNotes({ id }: { id: string }) {
  const { t } = useI18n()
  const [advisor, setAdvisor] = useState<{ on: boolean; interventions: Intervention[] } | null>(null)
  const [effects, setEffects] = useState<Effect[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      api<{ advisor: boolean; interventions: Intervention[] }>(`/api/workflows/${encodeURIComponent(id)}/interventions`)
        .then((r) => { if (alive) setAdvisor({ on: r.advisor, interventions: r.interventions }) }, () => {})
      api<{ effects: Effect[] }>(`/api/workflows/${encodeURIComponent(id)}/effects`)
        .then((r) => { if (alive) setEffects(r.effects) }, () => {})
    }
    load()
    const timer = setInterval(load, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id])

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('interventionsLabel')}</h3>
        {advisor && !advisor.on ? <Empty>{t('advisorOff')}</Empty> : null}
        {advisor?.on && advisor.interventions.length === 0 ? <Empty>{t('noInterventions')}</Empty> : null}
        <ul className="grid gap-2">
          {(advisor?.interventions ?? []).map((r) => (
            <li key={r.id} className="rounded-lg border p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{r.type}</Badge>
                <span className="font-medium">{r.task}</span>
                <span className="ml-auto text-xs text-muted-foreground">{r.state}</span>
              </div>
              <p className="text-xs text-muted-foreground">{r.trigger}</p>
              <p className="mt-1 text-xs text-muted-foreground">{r.reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('effectsLabel')}</h3>
        {effects && effects.length === 0 ? <Empty>{t('noEffects')}</Empty> : null}
        <ul className="grid gap-2">
          {(effects ?? []).map((r) => (
            <li key={r.id} className="rounded-lg border p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{r.kind}</code>
                <Badge variant="outline" className="text-[10px]">{r.state}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">{r.rule}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{r.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-muted-foreground">{t('notesReadOnly')}</p>
    </div>
  )
}
