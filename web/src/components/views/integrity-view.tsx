import { Download, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type VerifyReport } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ErrorNote, Loading, Mono } from './common'

export function IntegrityView({ runId, tick, onVerify }: { runId: string; tick: number; onVerify: () => Promise<void> }) {
  const { t } = useI18n()
  const { data: v, error } = useQuery<VerifyReport>(runPath(runId, '/verify'), tick)
  if (error) return <ErrorNote code={error} />
  if (!v) return <Loading />
  return (
    <div className="grid max-w-2xl gap-4">
      <Alert variant={v.ok ? 'default' : 'destructive'} className={v.ok ? 'border-status-done/50' : ''}>
        {v.ok ? <ShieldCheck className="text-status-done" /> : <ShieldAlert />}
        <AlertTitle>{v.ok ? t('verified') : t('broken')}</AlertTitle>
        <AlertDescription>
          <span>{v.events} {t('events')}{v.firstBadSeq ? ` · ${t('seq')} ${v.firstBadSeq}: ${v.reason}` : ''}</span>
          <Mono className="mt-1 block break-all text-muted-foreground">{v.head}</Mono>
        </AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button onClick={() => void onVerify()} data-verify><RefreshCw data-icon="inline-start" />{t('verifyNow')}</Button>
        <Button variant="outline" render={<a href={runPath(runId, '/export')} download={`${runId}.ledger.json`} />}>
          <Download data-icon="inline-start" />{t('download')}
        </Button>
      </div>
      <div className="grid gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('howVerify')}</h3>
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs">node scripts/verify-export.ts {runId}.ledger.json</pre>
      </div>
    </div>
  )
}
