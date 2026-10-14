import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Cite } from '@/components/evidence'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type CoordinationReport } from '@/lib/api'
import { fmtMs } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { Empty, ErrorNote, Loading } from './common'

export function CoordinationView({ runId, tick }: { runId: string; tick: number }) {
  const { t } = useI18n()
  const { data, error } = useQuery<CoordinationReport>(runPath(runId, '/coordination'), tick)
  if (error) return <ErrorNote code={error} />
  if (!data) return <Loading />
  if (!data.rows.length) return <Empty />
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('task')}</TableHead>
          <TableHead>{t('actions')}</TableHead>
          <TableHead>{t('waits')}</TableHead>
          <TableHead>{t('waitMs')}</TableHead>
          <TableHead>{t('stale')}</TableHead>
          <TableHead>{t('recoveries')}</TableHead>
          <TableHead>{t('evidence')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.map((r) => (
          <TableRow key={r.taskId}>
            <TableCell className="font-semibold">{r.taskId}</TableCell>
            <TableCell>{r.actions}</TableCell>
            <TableCell>{r.waits}</TableCell>
            <TableCell className="font-mono text-xs">{fmtMs(r.waitMs)}</TableCell>
            <TableCell>{r.staleViews}</TableCell>
            <TableCell>{r.recoveries}</TableCell>
            <TableCell><Cite runId={runId} evidence={r.evidence} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
