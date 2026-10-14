import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Cite } from '@/components/evidence'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type CostReport, type WasteReport } from '@/lib/api'
import { fmtTokens, fmtUsd } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { Empty, ErrorNote, Loading } from './common'

export function CostView({ runId, tick }: { runId: string; tick: number }) {
  const { t } = useI18n()
  const [by, setBy] = useState('profile')
  const cost = useQuery<CostReport>(runPath(runId, `/cost?by=${by}`), tick)
  const waste = useQuery<WasteReport>(runPath(runId, '/waste'), tick)
  const rows = cost.data?.rows ?? []
  const max = Math.max(1e-9, ...rows.map((r) => r.usd))
  return (
    <div className="grid gap-5">
      <Tabs value={by} onValueChange={(v) => setBy(String(v))}>
        <TabsList>
          <TabsTrigger value="profile">{t('byProfile')}</TabsTrigger>
          <TabsTrigger value="task">{t('byTask')}</TabsTrigger>
          <TabsTrigger value="model">{t('byModel')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {cost.error ? <ErrorNote code={cost.error} /> : !cost.data ? <Loading /> : !rows.length ? <Empty /> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead>{t('runs')}</TableHead>
              <TableHead>{t('tokens')}</TableHead>
              <TableHead>{t('usd')}</TableHead>
              <TableHead className="w-1/4" />
              <TableHead>{t('evidence')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const onlyUnknown = !r.usd && r.usdUnknownRuns > 0
              return (
                <TableRow key={r.key}>
                  <TableCell className="font-semibold">{r.key}</TableCell>
                  <TableCell>{r.succeeded}/{r.runs}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtTokens(r.inputTokens + r.outputTokens)}
                    {r.tokensUnknownRuns ? <span title={t('unknownNote')}> +{r.tokensUnknownRuns}×?</span> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {onlyUnknown ? '?' : fmtUsd(r.usd)}
                    {r.usdUnknownRuns ? <Badge variant="outline" title={t('unknownNote')} className="ml-2 border-status-approval/60 text-status-approval">{r.usd ? '+' : ''}{r.usdUnknownRuns} {t('unknownCost')}</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={onlyUnknown ? 'h-full bg-[repeating-linear-gradient(45deg,var(--color-status-approval),var(--color-status-approval)_5px,transparent_5px,transparent_10px)]' : 'h-full bg-primary'}
                        style={{ width: `${onlyUnknown ? 100 : Math.max(2, (r.usd / max) * 100)}%`, opacity: onlyUnknown ? 0.35 : 1 }}
                      />
                    </div>
                  </TableCell>
                  <TableCell><Cite runId={runId} evidence={r.evidence} /></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      <div className="grid gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('wastedRuns')}
          {waste.data ? ` · ${waste.data.wastedRuns.length}/${waste.data.totalRuns}${waste.data.wasteRatio != null ? ` · ${(waste.data.wasteRatio * 100).toFixed(1)}% ${t('tokens')}` : ''}` : ''}
        </h3>
        {waste.data?.wastedRuns.length ? waste.data.wastedRuns.map((w) => (
          <Alert key={w.id}>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <b>{w.profile}</b> <code className="font-mono text-xs text-muted-foreground">{w.id}</code> {w.why} <Cite runId={runId} evidence={w.evidence} />
            </AlertDescription>
          </Alert>
        )) : <span className="text-sm text-muted-foreground">—</span>}
      </div>
    </div>
  )
}
