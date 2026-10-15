// Library editor (plan 14 Q3.5). Providers, agents, skills and templates are versioned documents: the server accepts a
// document whole or refuses it with every problem. A provider is tested against its STORED endpoint and key; the report
// names the environment variable the key came from and never shows the key. Writes use the session cookie and the same
// origin, like every other write.
import { useCallback, useEffect, useState } from 'react'
import { Plug, Plus, Trash2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { type Key, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Empty, ErrorNote } from './common'
import { type Base, LibraryAgentDesigner } from './library-agent-designer'

const KINDS = ['providers', 'agents', 'skills', 'templates'] as const
type LibKind = (typeof KINDS)[number]
const KIND_KEY: Record<LibKind, Key> = { providers: 'libraryKindProviders', agents: 'libraryKindAgents', skills: 'libraryKindSkills', templates: 'libraryKindTemplates' }

/** A starting document per kind: plausible to the form, and the server still decides what is valid. */
const STARTER: Record<LibKind, (id: string) => Record<string, unknown>> = {
  providers: (id) => ({ id, protocol: 'openai-compatible', baseUrl: 'https://', apiKeyEnv: ['MY_PROVIDER_KEY'], models: [{ id: 'model-id' }] }),
  agents: (id) => ({ id, adapter: 'native', role: 'writer', description: '', tags: [], timeoutMs: 300000, enabled: true, provider: '', model: '' }),
  skills: (id) => ({ id, name: id, description: '', content: '' }),
  templates: (id) => ({ id, title: '' }),
}

interface Entry {
  kind: LibKind
  id: string
  digest: string
  document: Record<string, unknown>
  seq: number
  actor: string
}

interface Report {
  ok: boolean
  error: string | null
  keyFrom: string | null
  listing: { status: 'served'; models: string[]; notListed: string[] } | { status: 'unavailable'; detail: string }
  call: { model: string; ok: boolean; latencyMs: number; detail: string; usage: { promptTokens: number; completionTokens: number } | null; costUsd: number | null } | null
}

export function LibraryView({ session }: { session: boolean }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<LibKind>('providers')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  // the agent designer's choices, as the server reports them (plan 14 Q3.3)
  const [bases, setBases] = useState<Base[]>([])
  const [fileOnly, setFileOnly] = useState<string[]>([])
  const [providerIds, setProviderIds] = useState<string[]>([])
  const [skillsByAgent, setSkillsByAgent] = useState<Record<string, string[]>>({})

  const headers = (): Record<string, string> => ({ 'content-type': 'application/json' })
  const reset = (): void => {
    setErrors([])
    setFailure(null)
    setConfirming(false)
    setReport(null)
  }

  const load = useCallback(async () => {
    try {
      setEntries((await api<{ entries: Entry[] }>(`/api/library/${kind}`)).entries)
    } catch (e) {
      setFailure((e as Error).message)
    }
  }, [kind])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (kind !== 'agents') return
    void (async () => {
      try {
        const designer = await api<{ bases: Base[]; fields: { fileOnly: string[] } }>('/api/library/bases')
        setBases(designer.bases)
        setFileOnly(designer.fields.fileOnly)
        setProviderIds((await api<{ entries: Entry[] }>('/api/library/providers')).entries.map((e) => e.id))
        const config = await api<{ agentSkills?: Record<string, string[]> }>('/api/config')
        setSkillsByAgent(config.agentSkills ?? {})
      } catch (e) {
        setFailure((e as Error).message)
      }
    })()
  }, [kind])

  const open = (e: Entry) => {
    reset()
    setSelected(e.id)
    setText(JSON.stringify(e.document, null, 2))
  }
  const startNew = () => {
    const id = newId.trim()
    if (!id) return
    reset()
    setSelected(id)
    setText(JSON.stringify(STARTER[kind](id), null, 2))
  }

  const save = async () => {
    if (!session || !selected) return
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      reset()
      setFailure('BAD_JSON')
      return
    }
    setBusy(true)
    reset()
    try {
      await api<{ digest: string; changed: boolean }>(`/api/library/${kind}/${encodeURIComponent(selected)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(doc) })
      await load()
    } catch (e) {
      setFailure(e instanceof ApiError ? e.code : (e as Error).message)
      if (e instanceof ApiError) setErrors(e.errors)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!session || !selected) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      await api(`/api/library/${kind}/${encodeURIComponent(selected)}`, { method: 'DELETE', headers: headers() })
      setSelected(null)
      setText('')
      reset()
      await load()
    } catch (e) {
      // a refused delete names what still uses the entry (plan 14 Q5.2)
      setFailure(e instanceof ApiError ? (e.errors.length ? e.errors.join(' · ') : e.code) : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (!session || !selected) return
    setTesting(true)
    setReport(null)
    setFailure(null)
    try {
      setReport(await api<Report>(`/api/library/providers/${encodeURIComponent(selected)}/test`, { method: 'POST' }))
    } catch (e) {
      setFailure(e instanceof ApiError ? e.code : (e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const stored = entries.find((e) => e.id === selected) ?? null
  return (
    <div className="grid gap-5">
      <Tabs value={kind} onValueChange={(v) => { if (v) { setKind(v as LibKind); setSelected(null); setText(''); reset() } }}>
        <TabsList>{KINDS.map((k) => <TabsTrigger key={k} value={k}>{t(KIND_KEY[k])}</TabsTrigger>)}</TabsList>
      </Tabs>
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="grid content-start gap-2">
          {entries.length === 0 ? <Empty>{t('libraryEmpty')}</Empty> : null}
          {entries.map((e) => (
            <button key={e.id} type="button" onClick={() => open(e)} className={cn('rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted', selected === e.id && 'border-primary')}>
              <div className="font-mono font-semibold">{e.id}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('libraryVersion')} {e.seq} · <code className="font-mono">{e.digest.slice(7, 19)}</code></div>
            </button>
          ))}
          <div className="flex gap-2">
            <Input aria-label={t('libraryNewId')} placeholder={t('libraryNewId')} className="font-mono" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <Button variant="outline" disabled={!newId.trim()} onClick={startNew}>
              <Plus data-icon="inline-start" />
              {t('libraryNew')}
            </Button>
          </div>
        </div>
        <div className="grid min-w-0 content-start gap-4">
          {failure ? <ErrorNote code={failure} /> : null}
          {selected ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{selected}</span>
                  <Badge variant="outline">{t(KIND_KEY[kind])}</Badge>
                  <span className="text-xs font-normal text-muted-foreground">{stored ? `${t('libraryVersion')} ${stored.seq} · ${stored.digest.slice(7, 19)}` : t('libraryUnsaved')}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {kind === 'agents' ? <LibraryAgentDesigner text={text} onChange={(doc) => setText(JSON.stringify(doc, null, 2))} bases={bases} providerIds={providerIds} fileOnly={fileOnly} skillsByAgent={skillsByAgent} /> : null}
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="library-doc">{t('libraryDocument')}</FieldLabel>
                    <Textarea id="library-doc" rows={16} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
                  </Field>
                </FieldGroup>
                {errors.length > 0 ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <ul className="grid list-disc gap-1 pl-4">{errors.map((p) => <li key={p}>{p}</li>)}</ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {report ? <ReportView report={report} /> : null}
              </CardContent>
              <CardFooter className="flex flex-wrap items-center gap-2">
                <Button disabled={!session || busy} onClick={() => void save()}>{t('librarySave')}</Button>
                {stored ? (
                  <Button variant="outline" disabled={!session || busy} onClick={() => void remove()}>
                    <Trash2 data-icon="inline-start" />
                    {confirming ? t('libraryConfirmDelete') : t('libraryDelete')}
                  </Button>
                ) : null}
                {stored && kind === 'providers' ? (
                  <Button variant="outline" disabled={!session || testing} onClick={() => void test()}>
                    <Plug data-icon="inline-start" />
                    {testing ? t('libraryTesting') : t('libraryTest')}
                  </Button>
                ) : null}
                {!session ? <p className="text-xs text-destructive">{t('designerNoSession')}</p> : null}
              </CardFooter>
            </Card>
          ) : (
            <Empty>{t('libraryPickOne')}</Empty>
          )}
        </div>
      </div>
    </div>
  )
}

/** The test's answer. It names where the key came from; the key itself is never part of an answer. */
function ReportView({ report }: { report: Report }) {
  const { t } = useI18n()
  return (
    <div className="grid gap-3 rounded-xl border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={report.ok ? 'text-status-done' : 'text-destructive'}>{report.ok ? t('libraryTestOk') : t('libraryTestFail')}</Badge>
        {report.keyFrom ? <span className="text-xs text-muted-foreground">{t('libraryKeyFrom')} <code className="font-mono">{report.keyFrom}</code></span> : null}
      </div>
      {report.error ? <p className="text-xs text-destructive">{report.error}</p> : null}
      {report.listing.status === 'served' ? (
        <p className="text-xs">
          <span className="font-semibold">{t('libraryServed')}:</span> <span className="font-mono">{report.listing.models.join(', ') || '—'}</span>
          {report.listing.notListed.length > 0 ? <span className="text-muted-foreground"> · {report.listing.notListed.join(', ')} {t('libraryNotListed')}</span> : null}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('libraryNoListing')} ({report.listing.detail})</p>
      )}
      {report.call ? (
        <p className="text-xs">
          <span className="font-semibold">{t('libraryCallDetail')}:</span> <span className="font-mono">{report.call.model}</span> · {report.call.detail} · {report.call.latencyMs} ms
          {report.call.usage ? ` · ${report.call.usage.promptTokens}+${report.call.usage.completionTokens} tokens` : ''}
          {' · '}{t('libraryCost')}: {report.call.costUsd !== null ? `$${report.call.costUsd.toFixed(6)}` : t('unknownCost')}
        </p>
      ) : null}
    </div>
  )
}
