import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Loading } from './common'

interface Agent { id: string; tier: string; kinds: string[]; enabled: boolean; pool: string | null; cost: { basis: string; usdPerRun?: number }; disabledReason?: string }
interface Cfg { workspace?: string; commands?: string[]; pools?: { id: string; members: string[]; maxConcurrent: number }[]; policy?: unknown; startRequiresApproval?: boolean }

export function AgentsView() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [cfg, setCfg] = useState<Cfg>({})
  useEffect(() => {
    void api<{ agents: Agent[] }>('/api/catalog').then((r) => setAgents(r.agents)).catch(() => setAgents([]))
    void api<Cfg>('/api/config').then(setCfg).catch(() => {})
  }, [])
  if (!agents) return <Loading />
  return (
    <div className="grid gap-5">
      <Table>
        <TableHeader><TableRow><TableHead>id</TableHead><TableHead>{t('tierLabel')}</TableHead><TableHead>{t('capabilities')}</TableHead><TableHead>{t('poolLabel')}</TableHead><TableHead>{t('cost')}</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {agents.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-mono text-xs">{a.id}</TableCell>
              <TableCell><Badge variant="outline">{a.tier}</Badge></TableCell>
              <TableCell className="text-xs">{a.kinds.join(', ')}</TableCell>
              <TableCell className="text-xs">{a.pool ?? '—'}</TableCell>
              <TableCell className="text-xs">{a.cost.basis}{a.cost.usdPerRun !== undefined ? ` · $${a.cost.usdPerRun}` : ''}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{a.enabled ? t('enabled') : `${t('disabled')}${a.disabledReason ? ': ' + a.disabledReason : ''}`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="grid gap-1 text-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('policyLabel')}</h3>
        <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{JSON.stringify({ startRequiresApproval: cfg.startRequiresApproval, pools: cfg.pools, commands: cfg.commands, policy: cfg.policy }, null, 2)}</pre>
      </div>
    </div>
  )
}
