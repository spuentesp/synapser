import { useCallback, useEffect, useState } from 'react'
import { Pencil, Play, Plus, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Empty, ErrorNote } from './common'
import { WorkflowDesigner, type WorkflowDoc } from './workflow-designer'

interface Item { id: string; title: string; state: string; revision: number; reason: string | null }
interface Detail {
  id: string; state: string; reason: string | null; revision: number
  workflow: WorkflowDoc
  conditions: { id: string; statement: string; required: boolean; status: string; evidence: string | null; detail: string | null }[]
}
const STATE_TONE: Record<string, string> = { DONE: 'text-status-done', FAILED: 'text-destructive', CANCELLED: 'text-muted-foreground', RUNNING: 'text-status-running', AWAITING_START: 'text-status-waiting' }

export function WorkflowsView({ token, tick, selected, onSelect }: { token: string | null; tick: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useI18n()
  const [items, setItems] = useState<Item[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  // null: the designer is closed; { editing: null }: a new workflow; { editing: doc }: a draft being edited
  const [design, setDesign] = useState<{ editing: (WorkflowDoc & { id: string }) | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pollTick, setPoll] = useState(0)

  useEffect(() => {
    const h = setInterval(() => setPoll((n) => n + 1), 1500)
    return () => clearInterval(h)
  }, [])
  const load = useCallback(async () => {
    try {
      setItems((await api<{ workflows: Item[] }>('/api/workflows')).workflows)
      if (selected) setDetail(await api<Detail>(`/api/workflows/${encodeURIComponent(selected)}`))
      else setDetail(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [selected])
  useEffect(() => { void load() }, [load, tick, pollTick])

  const call = async (method: string, path: string, body?: unknown) => {
    if (!token) return
    setErr(null)
    try {
      const r = await api<{ id?: string }>(path, { method, headers: { 'content-type': 'application/json', 'x-synapser-token': token }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      if (r.id) onSelect(r.id)
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : (e as Error).message)
    }
  }
  const canStart = detail && ['DRAFT', 'AWAITING_START'].includes(detail.state)
  const live = detail && ['PLANNING', 'RUNNING', 'VERIFYING', 'AWAITING_START'].includes(detail.state)

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div className="grid content-start gap-2">
        {items.length === 0 ? <Empty>{t('noWorkflows')}</Empty> : null}
        {items.map((w) => (
          <button key={w.id} type="button" onClick={() => { setDesign(null); onSelect(w.id) }} className={cn('rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted', selected === w.id && 'border-primary')}>
            <div className="font-semibold">{w.title}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs"><span className={cn('font-semibold', STATE_TONE[w.state])}>{w.state}</span><code className="font-mono text-muted-foreground">{w.id}</code></div>
          </button>
        ))}
        <Button variant="outline" onClick={() => setDesign({ editing: null })}>
          <Plus data-icon="inline-start" />
          {t('designerNew')}
        </Button>
      </div>
      <div className="min-w-0">
        {err ? <ErrorNote code={err} /> : null}
        {design ? (
          <WorkflowDesigner
            key={design.editing?.id ?? 'new'}
            token={token}
            initial={design.editing}
            editingId={design.editing?.id ?? null}
            onSaved={(id) => { setDesign(null); onSelect(id); void load() }}
            onCancel={() => setDesign(null)}
          />
        ) : detail ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {detail.workflow.title}
                <Badge variant="outline" className={STATE_TONE[detail.state]}>{detail.state}</Badge>
                <span className="text-xs font-normal text-muted-foreground">r{detail.revision}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <p className="whitespace-pre-wrap text-muted-foreground">{detail.workflow.description}</p>
              {detail.reason ? <p className="text-xs text-destructive">{detail.reason}</p> : null}
              <div className="flex flex-wrap gap-2">
                {canStart ? <Button size="sm" onClick={() => void call('POST', `/api/workflows/${detail.id}/start`, {})}><Play data-icon="inline-start" />{t('startWorkflow')}</Button> : null}
                {live ? <Button size="sm" variant="outline" onClick={() => void call('POST', `/api/workflows/${detail.id}/cancel`, {})}><Square data-icon="inline-start" />{t('cancelWorkflow')}</Button> : null}
                {detail.state === 'DRAFT' ? <Button size="sm" variant="outline" onClick={() => setDesign({ editing: { ...detail.workflow, id: detail.id } })}><Pencil data-icon="inline-start" />{t('designerEdit')}</Button> : null}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('conditionsLabel')}</h3>
                <ul className="grid gap-2">
                  {detail.conditions.map((c) => (
                    <li key={c.id} className="rounded-lg border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('size-2 rounded-full', c.status === 'SATISFIED' ? 'bg-status-done' : c.status === 'FAILED' ? 'bg-destructive' : 'bg-status-waiting')} />
                        <span className="font-medium">{c.statement}</span>
                        <Badge variant="outline" className="text-[10px]">{c.required ? t('required') : t('optional')}</Badge>
                        <span className="ml-auto text-xs text-muted-foreground">{c.status}</span>
                      </div>
                      {c.detail ? <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
