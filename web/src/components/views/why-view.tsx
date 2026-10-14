import { useEffect, useState, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type ActionRow, type WhyReport } from '@/lib/api'
import { fmtMs, fmtUsd, shortHash } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { Empty, ErrorNote, Loading, Mono } from './common'

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative grid grid-cols-[110px_1fr] gap-3 border-l-2 py-3 pl-5">
      <span className="absolute -left-[7px] top-4 size-3 rounded-full bg-primary" />
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="grid gap-1 text-sm">{children}</div>
    </div>
  )
}

export function WhyView({ runId, tick }: { runId: string; tick: number }) {
  const { t } = useI18n()
  const acts = useQuery<{ actions: ActionRow[] }>(runPath(runId, '/actions'), tick)
  const list = (acts.data?.actions ?? []).filter((a) => a.files.length)
  const [pick, setPick] = useState<string | null>(null)
  // open on something useful: the most recent change that actually landed
  useEffect(() => {
    if (pick && list.some((a) => a.actionId === pick)) return
    const last = [...list].reverse().find((a) => ['SETTLED', 'APPLIED'].includes(a.state))
    setPick(last?.actionId ?? null)
  }, [list, pick])
  const why = useQuery<WhyReport>(pick ? runPath(runId, `/why?action=${encodeURIComponent(pick)}`) : null, tick)
  const w = why.data

  return (
    <div className="grid gap-4">
      <Select value={pick ?? ''} onValueChange={(v) => setPick(v || null)}>
        <SelectTrigger className="w-full max-w-xl">
          <SelectValue placeholder={t('pickAction')} />
        </SelectTrigger>
        <SelectContent><SelectGroup>
          {list.map((a) => (
            <SelectItem key={a.actionId} value={a.actionId}>
              {a.actionId} · {a.state} · {a.files.join(', ')}
            </SelectItem>
          ))}
        </SelectGroup></SelectContent>
      </Select>
      {acts.error ? <ErrorNote code={acts.error} /> : null}
      {!pick ? <Empty>{t('pickAction')}</Empty> : !w ? <Loading /> : !w.found ? <Empty /> : (
        <>
          <div>
            {w.mission ? (
              <Step label={t('mission')}>
                <span>{w.mission.objective} <Badge variant="secondary">{w.mission.state}</Badge></span>
              </Step>
            ) : null}
            {w.task ? (
              <Step label={t('task')}>
                <span><b>{w.task.id}</b> — {w.task.objective}</span>
                <span className="text-xs text-muted-foreground">scope: <b className="text-foreground">{w.task.scope.join(', ')}</b> · {w.task.state}</span>
                <span className="text-muted-foreground">{w.task.criteria.join(' · ')}</span>
              </Step>
            ) : null}
            <Step label={t('runs')}>
              {w.agentRuns.length ? w.agentRuns.map((r) => (
                <span key={r.id}>
                  <b>{r.profile}</b> <Badge variant="outline" className="font-mono text-[10px]">{r.adapter}</Badge> {r.outcome} · {fmtMs(r.durationMs)} ·{' '}
                  {r.usage.inputTokens ?? '?'}→{r.usage.outputTokens ?? '?'} tok · {fmtUsd(r.usage.costUsd)}{' '}
                  <span className="text-muted-foreground">({r.usage.provenance})</span>
                </span>
              )) : '—'}
              <span className="text-xs text-muted-foreground">{t('linkedBy')}: {w.linkedBy ?? '—'}</span>
            </Step>
            {w.action ? (
              <Step label={t('action')}>
                <span><Mono>{w.actionId}</Mono> <Badge variant="secondary">{w.action.state}</Badge></span>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {w.action.transitions.map((x) => (
                    <Mono key={x.seq} className="text-muted-foreground">
                      #{x.seq} {x.from ?? '∅'}→{x.to}{x.errorCode ? ` [${x.errorCode}]` : ''}
                    </Mono>
                  ))}
                </div>
              </Step>
            ) : null}
            {w.action ? (
              <Step label={t('files')}>
                {w.action.files.map((f) => (
                  <Mono key={f.path}>
                    {f.op} {f.path} <span className="text-muted-foreground">{shortHash(f.beforeDigest, 8)} → {shortHash(f.afterDigest, 8)}</span>
                  </Mono>
                ))}
              </Step>
            ) : null}
            <Step label={t('validations')}>
              {w.validations.length ? w.validations.map((v) => (
                <span key={v.id}>{v.command} · exit {String(v.exitCode)} {v.valid ? '' : '(snapshot)'} <Mono className="text-muted-foreground">{shortHash(v.snapshotDigest, 10)}</Mono></span>
              )) : '—'}
            </Step>
          </div>
          {w.asserted.length ? (
            <div className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('asserted')}</h3>
              {w.asserted.map((a) => (
                <Alert key={a.seq} className="border-status-approval/50">
                  <AlertTitle><Mono className="text-muted-foreground">#{a.seq} {a.source}</Mono></AlertTitle>
                  <AlertDescription>{a.text}</AlertDescription>
                </Alert>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
