import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type TimelineEntry } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { ErrorNote } from './common'

export function TimelineView({ runId, tick, upTo }: { runId: string; tick: number; upTo: number | null }) {
  const { t, lang } = useI18n()
  const { data, error } = useQuery<{ entries: TimelineEntry[] }>(runPath(runId, '/timeline'), tick)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('__all')
  const all = data?.entries ?? []
  const kinds = useMemo(() => [...new Set(all.map((e) => e.kind))].sort(), [all])
  const rows = useMemo(() => {
    const needle = q.toLowerCase()
    return all
      .filter((e) => (kind === '__all' || e.kind === kind) && (!needle || `${e.summary} ${e.id}`.toLowerCase().includes(needle)) && (upTo === null || e.seq <= upTo))
      .slice(-500)
      .reverse() // newest first
  }, [all, q, kind, upTo])
  if (error) return <ErrorNote code={error} />
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-64" placeholder={t('filter')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={kind} onValueChange={(v) => setKind(v ?? '__all')}>
          <SelectTrigger className="w-44" aria-label={t('kind')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="__all">{t('all')}</SelectItem>
            {kinds.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{rows.length}/{all.length}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">{t('seq')}</TableHead>
            <TableHead className="w-24">{t('time')}</TableHead>
            <TableHead className="w-40">{t('kind')}</TableHead>
            <TableHead>{t('summary')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.seq}>
              <TableCell className="font-mono text-xs">{e.seq}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{fmtTime(e.ts, lang)}</TableCell>
              <TableCell><Badge variant="secondary" className="font-mono text-[10px]">{e.kind}</Badge></TableCell>
              <TableCell className="whitespace-normal">{e.summary}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
