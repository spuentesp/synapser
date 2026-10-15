import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface TrialReport {
  outcome: string
  output: string | null
  costUsd: number | null
  durationMs: number
  skills: { id: string; digest: string; mechanism: string }[]
  changedPaths: string[]
  reason: string | null
  networkIsolated: boolean
}

interface Props {
  agentId: string
  adapter: string
  session: boolean
  onClose: () => void
}

export function AgentTrial({ agentId, adapter, session, onClose }: Props) {
  const { t } = useI18n()
  const [task, setTask] = useState('Report the current working directory.')
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(30)
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [report, setReport] = useState<TrialReport | null>(null)
  const cli = adapter !== 'native'

  const run = async (): Promise<void> => {
    if (!session || busy || !task.trim() || /[\r\n]/.test(task)) return
    setBusy(true)
    setFailure(null)
    setReport(null)
    try {
      const body = {
        task: task.trim(),
        timeLimitSeconds,
        ...(adapter === 'claude-code' && maxBudgetUsd.trim() !== '' ? { maxBudgetUsd: Number(maxBudgetUsd) } : {}),
      }
      const result = await api<TrialReport>(`/api/agents/${encodeURIComponent(agentId)}/trial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setReport(result)
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-agent-trial={agentId}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-3">
          <span>{t('agentTrial')} · <span className="font-mono text-sm">{agentId}</span></span>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('close')}</Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4">
        <Alert variant={cli ? 'destructive' : 'default'} data-network-warning={cli ? 'cli' : 'native'}>
          <AlertDescription>{cli ? t('agentTrialNetwork') : t('agentTrialNative')}</AlertDescription>
        </Alert>
        <FieldGroup className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto] md:items-end">
          <Field>
            <FieldLabel htmlFor="agent-trial-task">{t('agentTrialTask')}</FieldLabel>
            <Input id="agent-trial-task" value={task} maxLength={500} onChange={(event) => setTask(event.target.value.replace(/[\r\n]/g, ' '))} />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-trial-time">{t('agentTrialTime')}</FieldLabel>
            <Input id="agent-trial-time" type="number" min={10} max={600} step={1} value={timeLimitSeconds} onChange={(event) => setTimeLimitSeconds(Number(event.target.value))} />
          </Field>
          {adapter === 'claude-code' ? (
            <Field>
              <FieldLabel htmlFor="agent-trial-budget">{t('agentTrialBudget')}</FieldLabel>
              <Input id="agent-trial-budget" type="number" min={0.01} max={1000} step={0.01} value={maxBudgetUsd} onChange={(event) => setMaxBudgetUsd(event.target.value)} />
            </Field>
          ) : null}
          <Button type="button" onClick={() => void run()} disabled={!session || busy || !task.trim() || /[\r\n]/.test(task) || !Number.isInteger(timeLimitSeconds) || timeLimitSeconds < 10 || timeLimitSeconds > 600 || (adapter === 'claude-code' && maxBudgetUsd.trim() !== '' && (!Number.isFinite(Number(maxBudgetUsd)) || Number(maxBudgetUsd) <= 0 || Number(maxBudgetUsd) > 1000))}>
            {busy ? t('agentTrialRunning') : t('agentTrialRun')}
          </Button>
        </FieldGroup>
        {!session ? <p className="text-xs text-destructive">{t('agentTrialNoSession')}</p> : null}
        {failure ? <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
        {report ? (
          <section className="grid gap-3 rounded-lg border bg-muted/20 p-3" aria-live="polite" data-trial-result>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={report.outcome.toUpperCase() === 'SUCCEEDED' ? 'default' : 'destructive'}>{report.outcome}</Badge>
              <span className="text-xs text-muted-foreground">{t('agentTrialDuration')}: {report.durationMs} ms</span>
              <span className="text-xs text-muted-foreground">{t('agentTrialCost')}: {report.costUsd === null ? t('unknownCost') : `$${report.costUsd.toFixed(6)} USD`}</span>
            </div>
            {report.reason ? <p className="text-sm text-destructive">{t('agentTrialReason')}: {report.reason}</p> : null}
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('agentTrialOutput')}</h3>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-xs">{report.output ?? '—'}</pre>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('agentTrialSkills')}</h3>
              {report.skills.length ? <ul className="grid gap-1 text-xs">{report.skills.map((skill) => <li key={`${skill.id}:${skill.digest}`}><span className="font-mono">{skill.id}</span> · {skill.mechanism} · <span className="font-mono">{skill.digest.slice(0, 12)}</span></li>)}</ul> : <p className="text-xs text-muted-foreground">{t('agentTrialNoSkills')}</p>}
            </div>
            {report.changedPaths.length ? <div><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('agentTrialChanged')}</h3><ul className="font-mono text-xs">{report.changedPaths.map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
            {cli && report.networkIsolated === false ? <p className="text-xs text-destructive">{t('agentTrialNetwork')}</p> : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  )
}
