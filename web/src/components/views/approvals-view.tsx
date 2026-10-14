import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/status-badge'
import { api, ApiError, runPath, type SwarmState } from '@/lib/api'
import { shortHash } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { Empty } from './common'

export function ApprovalsView({ runId, state, token, onDecided }: { runId: string; state: SwarmState; token: string | null; onDecided: () => Promise<void> }) {
  const { t } = useI18n()
  const [actor, setActor] = useState(() => localStorage.getItem('actor') ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!state.pendingApprovals.length) {
    return (
      <div className="grid gap-3">
        <Empty>{t('noApprovals')}</Empty>
        {msg ? <p className="text-sm text-muted-foreground" data-testid="decide-msg">{msg}</p> : null}
      </div>
    )
  }
  const decide = async (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    const name = actor.trim() || 'ui:anonymous'
    localStorage.setItem('actor', name)
    setBusy(true)
    try {
      await api(runPath(runId, `/approvals/${encodeURIComponent(taskId)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-synapser-token': token ?? '' },
        body: JSON.stringify({ decision, actor: name, planDigest: state.planDigest }),
      })
      setMsg(t('decided'))
    } catch (e) {
      setMsg(e instanceof ApiError && e.code === 'STALE_DIGEST' ? t('staleDigest') : e instanceof ApiError ? e.code : String(e))
    } finally {
      setBusy(false)
      await onDecided()
    }
  }
  return (
    <div className="grid gap-4">
      <Field className="max-w-xs">
        <FieldLabel htmlFor="actor">{t('actor')}</FieldLabel>
        <Input id="actor" value={actor} onChange={(e) => setActor(e.target.value)} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        {state.pendingApprovals.map((id) => {
          const a = state.agents.find((x) => x.taskId === id)
          return (
            <Card key={id} className="border-l-4 border-l-status-approval">
              <CardContent className="grid gap-3 px-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{id}</span>
                  <StatusBadge status="waiting_approval" />
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{t('planDigest')} <code className="font-mono">{shortHash(state.planDigest, 14)}</code></span>
                  {a?.profile ? <b className="text-foreground">{a.profile}</b> : null}
                </div>
                <div className="flex gap-2">
                  <Button disabled={busy} data-decide="APPROVED" onClick={() => void decide(id, 'APPROVED')}><Check data-icon="inline-start" />{t('approve')}</Button>
                  <Button disabled={busy} variant="destructive" data-decide="REJECTED" onClick={() => void decide(id, 'REJECTED')}><X data-icon="inline-start" />{t('reject')}</Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
      {msg ? <p className="text-sm text-muted-foreground" data-testid="decide-msg">{msg}</p> : null}
    </div>
  )
}
