import { useState } from 'react'
import { Check, KeyRound, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api, ApiError, runPath, type SwarmState } from '@/lib/api'
import { shortHash } from '@/lib/format'
import { type Key, useI18n } from '@/lib/i18n'
import { Empty } from './common'

const KIND: Record<SwarmState['gates'][number]['kind'], Key> = { start: 'gateStart', step: 'gateStep', condition: 'gateCondition', effect: 'gateEffect', intervention: 'gateIntervention' }

export function ApprovalsView({ runId, state, session, onDecided }: { runId: string; state: SwarmState; session: boolean; onDecided: () => Promise<void> }) {
  const { t } = useI18n()
  const [actor, setActor] = useState(() => localStorage.getItem('actor') ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<Record<string, string>>({})

  if (!state.gates.length) {
    return (
      <div className="grid gap-3">
        <Empty>{t('noApprovals')}</Empty>
        {msg ? <p className="text-sm text-muted-foreground" data-testid="decide-msg">{msg}</p> : null}
      </div>
    )
  }
  const decide = async (key: string, digest: string, decision: 'APPROVED' | 'REJECTED') => {
    const name = actor.trim() || 'ui:anonymous'
    localStorage.setItem('actor', name)
    setBusy(true)
    try {
      await api(runPath(runId, `/approvals/${encodeURIComponent(key)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, actor: name, planDigest: digest }),
      })
      setMsg(t('decided'))
    } catch (e) {
      setMsg(e instanceof ApiError && e.code === 'STALE_DIGEST' ? t('staleDigest') : e instanceof ApiError ? e.code : String(e))
    } finally {
      setBusy(false)
      await onDecided()
    }
  }
  const showCode = async (key: string, digest: string) => {
    try {
      const r = await api<{ code: string }>(runPath(runId, `/challenge?key=${encodeURIComponent(key)}&digest=${encodeURIComponent(digest)}`))
      setCodes((c) => ({ ...c, [key]: r.code }))
    } catch (e) {
      setMsg(e instanceof ApiError ? e.code : String(e))
    }
  }
  return (
    <div className="grid gap-4">
      <Field className="max-w-xs">
        <FieldLabel htmlFor="actor">{t('actor')}</FieldLabel>
        <Input id="actor" value={actor} onChange={(e) => setActor(e.target.value)} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        {state.gates.map((g) => (
          <Card key={g.key} data-testid="gate" data-key={g.key} className="border-l-4 border-l-status-approval">
            <CardHeader className="px-4">
              <CardTitle className="break-all">{g.key}</CardTitle>
              <CardAction><Badge variant="outline">{t(KIND[g.kind])}</Badge></CardAction>
            </CardHeader>
            <CardContent className="grid gap-3 px-4">
              {g.summary ? <p className="text-sm">{g.summary}</p> : null}
              <span className="text-xs text-muted-foreground">{t('planDigest')} <code className="font-mono">{shortHash(g.digest, 14)}</code></span>
              {codes[g.key] ? (
                <Alert>
                  <KeyRound />
                  <AlertDescription>
                    <code className="font-mono text-base font-bold tracking-widest" data-testid="challenge-code">{codes[g.key]}</code>
                    <span className="block text-xs text-muted-foreground">{t('codeNote')}</span>
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button disabled={!session || busy} data-decide="APPROVED" onClick={() => void decide(g.key, g.digest, 'APPROVED')}><Check data-icon="inline-start" />{t('approve')}</Button>
                <Button disabled={!session || busy} variant="destructive" data-decide="REJECTED" onClick={() => void decide(g.key, g.digest, 'REJECTED')}><X data-icon="inline-start" />{t('reject')}</Button>
                <Button disabled={!session || busy} variant="outline" data-show-code onClick={() => void showCode(g.key, g.digest)}><KeyRound data-icon="inline-start" />{t('showCode')}</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {msg ? <p className="text-sm text-muted-foreground" data-testid="decide-msg">{msg}</p> : null}
    </div>
  )
}
