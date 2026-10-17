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

const KINDS = ['providers', 'agents', 'skills', 'templates', 'recipes'] as const
type LibKind = (typeof KINDS)[number]
const KIND_KEY: Record<LibKind, Key> = { providers: 'libraryKindProviders', agents: 'libraryKindAgents', skills: 'libraryKindSkills', templates: 'libraryKindTemplates', recipes: 'libraryKindRecipes' }

/** A starting document per kind: plausible to the form, and the server still decides what is valid. */
const STARTER: Record<LibKind, (id: string) => Record<string, unknown>> = {
  providers: (id) => ({ id, protocol: 'openai-compatible', baseUrl: 'https://', apiKeyEnv: ['MY_PROVIDER_KEY'], models: [{ id: 'model-id' }] }),
  agents: (id) => ({ id, adapter: 'native', role: 'writer', description: '', tags: [], timeoutMs: 300000, enabled: true, provider: '', model: '' }),
  skills: (id) => ({ id, name: id, description: '', content: '' }),
  templates: (id) => ({ id, title: '' }),
  recipes: (id) => ({ id, schemaVersion: 1, title: id, description: 'A curated task recipe with an explicit human acceptance gate.', category: 'review', parameters: [], requiredCapabilities: [], requiredSkills: [], requiredMcpServers: [], workflow: { title: id, description: 'Inspect the requested scope and return a concise report.', goals: ['Inspect the requested scope.'], nonGoals: [], conditions: [{ id: 'operator-approval', statement: 'The operator approves the resulting report.', checker: { kind: 'approval', prompt: 'Approve the report?' }, required: true }], budget: { minutes: 15 } }, startPolicy: 'human_approval' }),
}

interface Entry {
  kind: LibKind
  id: string
  digest: string
  document: Record<string, unknown>
  seq: number
  actor: string
  published?: boolean
}

interface Report {
  ok: boolean
  error: string | null
  keyFrom: string | null
  listing: { status: 'served'; models: string[]; notListed: string[] } | { status: 'unavailable'; detail: string }
  call: { model: string; ok: boolean; latencyMs: number; detail: string; usage: { promptTokens: number; completionTokens: number } | null; costUsd: number | null } | null
}

interface SkillHistory { seq: number; operation: 'PUT' | 'DELETE' | 'ROLLBACK'; digest: string; actor: string; reason?: string }
interface Evaluation { candidateId: string; eligible: boolean; checks: { caseId: string; repetition: number; passed: boolean }[] }

export function LibraryView({ session }: { session: boolean }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<LibKind>('providers')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  // the agent designer's choices, as the server reports them (plan 14 Q3.3)
  const [bases, setBases] = useState<Base[]>([])
  const [fileOnly, setFileOnly] = useState<string[]>([])
  const [providerIds, setProviderIds] = useState<string[]>([])
  const [skillsByAgent, setSkillsByAgent] = useState<Record<string, string[]>>({})
  const [history, setHistory] = useState<SkillHistory[]>([])
  const [rollbackReason, setRollbackReason] = useState('')
  const [caseText, setCaseText] = useState('[]')
  const [outputText, setOutputText] = useState('[]')
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [evaluating, setEvaluating] = useState(false)

  const headers = (): Record<string, string> => ({ 'content-type': 'application/json' })
  const reset = (): void => {
    setErrors([])
    setFailure(null)
    setNotice(null)
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
    setSavedText(JSON.stringify(e.document, null, 2))
    setEvaluation(null)
    setHistory([])
    if (e.kind === 'skills') void api<{ history: SkillHistory[] }>(`/api/library/skills/${encodeURIComponent(e.id)}/history`).then((r) => setHistory(r.history)).catch((error: unknown) => setFailure((error as Error).message))
  }
  const startNew = () => {
    const id = newId.trim()
    if (!id) return
    reset()
    setHistory([])
    setEvaluation(null)
    setRollbackReason('')
    setSelected(id)
    setText(JSON.stringify(STARTER[kind](id), null, 2))
    setSavedText('')
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
      setSavedText(JSON.stringify(doc, null, 2))
      await load()
      if (kind === 'skills') setHistory((await api<{ history: SkillHistory[] }>(`/api/library/skills/${encodeURIComponent(selected)}/history`)).history)
    } catch (e) {
      setFailure(e instanceof ApiError ? e.code : (e as Error).message)
      if (e instanceof ApiError) setErrors(e.errors)
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    if (!session || !selected) return
    let doc: unknown
    try { doc = JSON.parse(text) } catch { setFailure('BAD_JSON'); return }
    setBusy(true); reset()
    try {
      await api(`/api/library/${kind}/${encodeURIComponent(selected)}/check`, { method: 'POST', headers: headers(), body: JSON.stringify(doc) })
      setNotice(t('libraryDocumentValid'))
    } catch (e) {
      setFailure(e instanceof ApiError ? e.code : (e as Error).message)
      if (e instanceof ApiError) setErrors(e.errors)
    } finally { setBusy(false) }
  }

  const evaluate = async (split: 'dev' | 'holdout') => {
    if (!session || !selected) return
    let candidate: Record<string, unknown>, cases: unknown, outputs: unknown
    try { candidate = JSON.parse(text) as Record<string, unknown>; cases = JSON.parse(caseText); outputs = JSON.parse(outputText) } catch { setFailure('BAD_EVALUATION_JSON'); return }
    setEvaluating(true); setEvaluation(null); setFailure(null)
    try {
      setEvaluation(await api<Evaluation>(`/api/library/skills/${encodeURIComponent(selected)}/evaluate`, { method: 'POST', headers: headers(), body: JSON.stringify({ split, candidate: { id: selected, content: candidate.content }, cases, outputs }) }))
    } catch (e) {
      setFailure(e instanceof ApiError ? e.errors.join(' · ') || e.code : (e as Error).message)
    } finally { setEvaluating(false) }
  }

  const rollback = async (digest: string) => {
    if (!session || !selected || !rollbackReason.trim()) return
    setBusy(true); reset()
    try {
      await api(`/api/library/skills/${encodeURIComponent(selected)}/rollback`, { method: 'POST', headers: headers(), body: JSON.stringify({ digest, reason: rollbackReason }) })
      setRollbackReason('')
      await load()
      const refreshed = await api<{ history: SkillHistory[] }>(`/api/library/skills/${encodeURIComponent(selected)}/history`)
      setHistory(refreshed.history)
      const entry = await api<Entry>(`/api/library/skills/${encodeURIComponent(selected)}`)
      setText(JSON.stringify(entry.document, null, 2))
    } catch (e) { setFailure(e instanceof ApiError ? e.errors.join(' · ') || e.code : (e as Error).message) } finally { setBusy(false) }
  }

  const publishRecipe = async () => {
    if (!session || !selected || !stored || kind !== 'recipes' || text !== savedText) return
    setBusy(true); reset()
    try {
      await api(`/api/library/recipes/${encodeURIComponent(selected)}/publish`, { method: 'POST', headers: headers(), body: JSON.stringify({ digest: stored.digest }) })
      await load()
      setNotice(t('recipePublished'))
    } catch (e) {
      setFailure(e instanceof ApiError ? e.errors.join(' · ') || e.code : (e as Error).message)
    } finally { setBusy(false) }
  }

  const unpublishRecipe = async () => {
    if (!session || !selected || !stored || kind !== 'recipes') return
    setBusy(true); reset()
    try {
      await api(`/api/library/recipes/${encodeURIComponent(selected)}/unpublish`, { method: 'POST', headers: headers() })
      await load()
      setNotice(t('recipeUnpublished'))
    } catch (e) {
      setFailure(e instanceof ApiError ? e.errors.join(' · ') || e.code : (e as Error).message)
    } finally { setBusy(false) }
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
          {notice ? <p role="status" className="text-sm text-status-done">{notice}</p> : null}
          {selected ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{selected}</span>
                  <Badge variant="outline">{t(KIND_KEY[kind])}</Badge>
                  <span className="text-xs font-normal text-muted-foreground">{stored ? `${t('libraryVersion')} ${stored.seq} · ${stored.digest.slice(7, 19)}` : t('libraryUnsaved')}</span>
                  {kind === 'recipes' && stored ? <Badge variant="outline">{stored.published ? t('recipePublicationPublished') : t('recipePublicationDraft')}</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {kind === 'agents' ? <LibraryAgentDesigner text={text} onChange={(doc) => setText(JSON.stringify(doc, null, 2))} bases={bases} providerIds={providerIds} fileOnly={fileOnly} skillsByAgent={skillsByAgent} /> : null}
                {kind === 'recipes' ? <RecipeDesigner text={text} onChange={setText} /> : null}
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
                {kind === 'skills' ? <SkillCurationPanel caseText={caseText} setCaseText={setCaseText} outputText={outputText} setOutputText={setOutputText} evaluation={evaluation} evaluating={evaluating} onEvaluate={(split) => void evaluate(split)} history={history} currentDigest={stored?.digest ?? null} rollbackReason={rollbackReason} setRollbackReason={setRollbackReason} onRollback={(digest) => void rollback(digest)} busy={busy} /> : null}
              </CardContent>
              <CardFooter className="flex flex-wrap items-center gap-2">
                <Button disabled={!session || busy} onClick={() => void save()}>{t('librarySave')}</Button>
                {(kind === 'skills' || kind === 'recipes') ? <Button variant="outline" disabled={!session || busy} onClick={() => void check()}>{t('libraryValidate')}</Button> : null}
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
                {stored && kind === 'recipes' ? <Button variant="outline" disabled={!session || busy || (!stored.published && text !== savedText)} onClick={() => void (stored.published ? unpublishRecipe() : publishRecipe())}>{stored.published ? t('recipeUnpublish') : t('recipePublish')}</Button> : null}
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

function RecipeDesigner({ text, onChange }: { text: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  let doc: Record<string, unknown> = {}
  try { doc = JSON.parse(text) as Record<string, unknown> } catch { /* the JSON editor owns parse errors */ }
  const workflow = (doc.workflow && typeof doc.workflow === 'object' ? doc.workflow : {}) as Record<string, unknown>
  const conditions = Array.isArray(workflow.conditions) ? workflow.conditions as Record<string, unknown>[] : []
  const parameters = Array.isArray(doc.parameters) ? doc.parameters as Record<string, unknown>[] : []
  const skills = Array.isArray(doc.requiredSkills) ? doc.requiredSkills as Record<string, unknown>[] : []
  const mcpTools = Array.isArray(doc.requiredMcpTools) ? doc.requiredMcpTools as Record<string, unknown>[] : []
  const update = (key: string, value: unknown) => onChange(JSON.stringify({ ...doc, [key]: value, ...(key === 'title' ? { workflow: { ...workflow, title: value } } : key === 'description' ? { workflow: { ...workflow, description: value } } : {}) }, null, 2))
  const updateMany = (values: Record<string, unknown>) => onChange(JSON.stringify({ ...doc, ...values }, null, 2))
  const updateWorkflow = (key: string, value: unknown) => update('workflow', { ...workflow, [key]: value })
  const updateCondition = (index: number, changes: Record<string, unknown>) => updateWorkflow('conditions', conditions.map((condition, i) => i === index ? { ...condition, ...changes } : condition))
  const updateChecker = (index: number, checker: Record<string, unknown>) => updateCondition(index, { checker })
  const updateParameter = (index: number, changes: Record<string, unknown>) => update('parameters', parameters.map((parameter, i) => i === index ? { ...parameter, ...changes } : parameter))
  const updateSkill = (index: number, changes: Record<string, unknown>) => update('requiredSkills', skills.map((skill, i) => i === index ? { ...skill, ...changes } : skill))
  const updateMcpTool = (index: number, changes: Record<string, unknown>) => {
    const tools = mcpTools.map((tool, i) => i === index ? { ...tool, ...changes } : tool)
    updateMany({ requiredMcpTools: tools, requiredMcpServers: [...new Set(tools.map((tool) => String(tool.serverId ?? '')).filter(Boolean))] })
  }
  const addParameter = () => update('parameters', [...parameters, { name: `input-${parameters.length + 1}`, type: 'string', description: 'Describe this input.', required: true }])
  const setParameterType = (index: number, type: string) => {
    const parameter = parameters[index] ?? {}
    const defaults: Record<string, unknown> = {
      string: { default: '', maxLength: 4000 }, string_list: { default: [], maxItems: 40 },
      integer: { minimum: 0, maximum: 100 }, boolean: { default: false }, enum: { options: ['option-a'], default: 'option-a' },
    }
    const common = Object.fromEntries(Object.entries(parameter).filter(([key]) => !['default', 'maxLength', 'maxItems', 'minimum', 'maximum', 'options'].includes(key)))
    updateParameter(index, { ...common, type, ...(defaults[type] ?? {}) })
  }
  const addSkill = () => update('requiredSkills', [...skills, { id: 'skill-id', required: true }])
  const addMcpTool = () => {
    const tools = [...mcpTools, { serverId: 'server-id', toolName: 'tool-name' }]
    updateMany({ requiredMcpTools: tools, requiredMcpServers: [...new Set(tools.map((tool) => String(tool.serverId ?? '')).filter(Boolean))] })
  }
  const nonGoals = Array.isArray(workflow.nonGoals) ? workflow.nonGoals : []
  const editableNonGoals = nonGoals.filter((goal): goal is string => typeof goal === 'string')
  const updateTextList = (key: string, value: string) => update(key, value.split('\n').map((line) => line.trim()).filter(Boolean))
  const addCondition = () => updateWorkflow('conditions', [...conditions, { id: `acceptance-${conditions.length + 1}`, statement: 'The required result is present.', checker: { kind: 'approval', prompt: 'Does the result meet the acceptance condition?' }, required: true }])
  const removeCondition = (index: number) => updateWorkflow('conditions', conditions.filter((_, i) => i !== index))
  const setCheckerKind = (index: number, kind: string) => {
    const defaults: Record<string, Record<string, unknown>> = {
      approval: { kind, prompt: 'Does the result meet the acceptance condition?' },
      file: { kind, path: 'report.md', assert: 'exists' },
      command: { kind, commandId: '' },
      citations: { kind, file: 'report.md', min: 1 },
      diff: { kind, require: [], forbid: [] },
      review: { kind, profile: '', rubric: 'Report findings with evidence.' },
    }
    updateChecker(index, defaults[kind] ?? { kind })
    if (kind === 'review') updateCondition(index, { required: false, checker: defaults[kind] })
  }
  return (
    <section className="grid gap-3 rounded-xl border p-4" aria-label={t('recipeDesigner')}>
      <h3 className="font-semibold">{t('recipeDesigner')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="recipe-title">{t('recipeTitle')}</FieldLabel><Input id="recipe-title" value={String(doc.title ?? '')} onChange={(e) => update('title', e.target.value)} /></Field>
        <Field><FieldLabel htmlFor="recipe-category">{t('recipeCategory')}</FieldLabel><select id="recipe-category" className="h-9 rounded-lg border bg-background px-2 text-sm" value={String(doc.category ?? 'review')} onChange={(e) => update('category', e.target.value)}>{['review', 'adversarial_review', 'alternatives', 'research', 'implementation'].map((category) => <option key={category} value={category}>{category}</option>)}</select></Field>
        <Field><FieldLabel htmlFor="recipe-start-policy">{t('recipeStartPolicy')}</FieldLabel><select id="recipe-start-policy" className="h-9 rounded-lg border bg-background px-2 text-sm" value={String(doc.startPolicy ?? 'human_approval')} onChange={(e) => update('startPolicy', e.target.value)}><option value="draft">draft</option><option value="human_approval">human_approval</option><option value="auto_start_bounded">auto_start_bounded</option></select></Field>
        <Field><FieldLabel htmlFor="recipe-budget">{t('recipeBudget')}</FieldLabel><Input id="recipe-budget" type="number" min="1" max="1440" value={String((workflow.budget as Record<string, unknown> | undefined)?.minutes ?? 15)} onChange={(e) => updateWorkflow('budget', { ...(workflow.budget as object ?? {}), minutes: Number(e.target.value) })} /></Field>
        <Field><FieldLabel htmlFor="recipe-budget-usd">{t('recipeBudgetUsd')}</FieldLabel><Input id="recipe-budget-usd" type="number" min="0.01" step="0.01" value={String((workflow.budget as Record<string, unknown> | undefined)?.usd ?? '')} onChange={(e) => updateWorkflow('budget', { ...(workflow.budget as object ?? {}), usd: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
      </div>
      <Field><FieldLabel htmlFor="recipe-description">{t('recipePurpose')}</FieldLabel><Textarea id="recipe-description" rows={2} value={String(doc.description ?? '')} onChange={(e) => update('description', e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="recipe-workflow-title">{t('recipeWorkflowTitle')}</FieldLabel><Input id="recipe-workflow-title" value={String(workflow.title ?? '')} onChange={(e) => updateWorkflow('title', e.target.value)} /></Field>
        <Field><FieldLabel htmlFor="recipe-workflow-description">{t('recipeWorkflowDescription')}</FieldLabel><Textarea id="recipe-workflow-description" rows={2} value={String(workflow.description ?? '')} onChange={(e) => updateWorkflow('description', e.target.value)} /></Field>
      </div>
      <Field><FieldLabel htmlFor="recipe-goals">{t('recipeGoals')}</FieldLabel><Textarea id="recipe-goals" rows={3} value={Array.isArray(workflow.goals) ? workflow.goals.join('\n') : ''} onChange={(e) => updateWorkflow('goals', e.target.value.split('\n').filter(Boolean))} /></Field>
      <Field><FieldLabel htmlFor="recipe-non-goals">{t('recipeNonGoals')}</FieldLabel><Textarea id="recipe-non-goals" rows={2} value={editableNonGoals.join('\n')} onChange={(e) => updateWorkflow('nonGoals', [...nonGoals.filter((goal) => typeof goal !== 'string'), ...e.target.value.split('\n').map((line) => line.trim()).filter(Boolean)])} /></Field>
      <section className="grid gap-3 rounded-lg border p-3" aria-label={t('recipeRequirements')}>
        <h4 className="text-sm font-semibold">{t('recipeRequirements')}</h4>
        <Field><FieldLabel htmlFor="recipe-capabilities">{t('recipeCapabilities')}</FieldLabel><Textarea id="recipe-capabilities" rows={2} value={Array.isArray(doc.requiredCapabilities) ? doc.requiredCapabilities.join('\n') : ''} onChange={(e) => updateTextList('requiredCapabilities', e.target.value)} /></Field>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2"><h5 className="text-sm">{t('recipeRequiredSkills')}</h5><Button type="button" size="sm" variant="outline" onClick={addSkill}>{t('recipeAddSkill')}</Button></div>
          {skills.map((skill, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end"><Field><FieldLabel htmlFor={`recipe-skill-${index}`}>{t('recipeSkillId')}</FieldLabel><Input id={`recipe-skill-${index}`} value={String(skill.id ?? '')} onChange={(e) => updateSkill(index, { id: e.target.value })} /></Field><label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={skill.required !== false} onChange={(e) => updateSkill(index, { required: e.target.checked })} />{t('recipeRequired')}</label><Button type="button" size="sm" variant="ghost" aria-label={`${t('recipeRemoveSkill')} ${index + 1}`} onClick={() => update('requiredSkills', skills.filter((_, i) => i !== index))}>{t('recipeRemoveSkill')}</Button></div>)}
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2"><h5 className="text-sm">{t('recipeMcpTools')}</h5><Button type="button" size="sm" variant="outline" onClick={addMcpTool}>{t('recipeAddMcpTool')}</Button></div>
          <p className="text-xs text-muted-foreground">{t('recipeMcpToolNote')}</p>
          {mcpTools.map((tool, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Field><FieldLabel htmlFor={`recipe-mcp-server-${index}`}>{t('recipeMcpServer')}</FieldLabel><Input id={`recipe-mcp-server-${index}`} value={String(tool.serverId ?? '')} onChange={(e) => updateMcpTool(index, { serverId: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-mcp-tool-${index}`}>{t('recipeMcpTool')}</FieldLabel><Input id={`recipe-mcp-tool-${index}`} value={String(tool.toolName ?? '')} onChange={(e) => updateMcpTool(index, { toolName: e.target.value })} /></Field><Button type="button" size="sm" variant="ghost" aria-label={`${t('recipeRemoveMcpTool')} ${index + 1}`} onClick={() => { const tools = mcpTools.filter((_, i) => i !== index); updateMany({ requiredMcpTools: tools, requiredMcpServers: [...new Set(tools.map((item) => String(item.serverId ?? '')).filter(Boolean))] }) }}>{t('recipeRemoveMcpTool')}</Button></div>)}
        </div>
      </section>
      <section className="grid gap-3 rounded-lg border p-3" aria-label={t('recipeParameters')}>
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t('recipeParameters')}</h4><Button type="button" size="sm" variant="outline" onClick={addParameter}>{t('recipeAddParameter')}</Button></div>
        {parameters.map((parameter, index) => {
          const parameterType = String(parameter.type ?? 'string')
          return <div key={index} className="grid gap-3 rounded-lg border p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto_auto] sm:items-end"><Field><FieldLabel htmlFor={`recipe-param-name-${index}`}>{t('recipeParameterName')}</FieldLabel><Input id={`recipe-param-name-${index}`} value={String(parameter.name ?? '')} onChange={(e) => updateParameter(index, { name: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-param-type-${index}`}>{t('recipeParameterType')}</FieldLabel><select id={`recipe-param-type-${index}`} className="h-9 rounded-lg border bg-background px-2 text-sm" value={parameterType} onChange={(e) => setParameterType(index, e.target.value)}>{['string', 'string_list', 'integer', 'boolean', 'enum'].map((type) => <option key={type} value={type}>{type}</option>)}</select></Field><Field><FieldLabel htmlFor={`recipe-param-description-${index}`}>{t('recipeParameterDescription')}</FieldLabel><Input id={`recipe-param-description-${index}`} value={String(parameter.description ?? '')} onChange={(e) => updateParameter(index, { description: e.target.value })} /></Field><label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={parameter.required === true} onChange={(e) => updateParameter(index, { required: e.target.checked })} />{t('recipeRequired')}</label><Button type="button" size="sm" variant="ghost" aria-label={`${t('recipeRemoveParameter')} ${index + 1}`} onClick={() => update('parameters', parameters.filter((_, i) => i !== index))}>{t('recipeRemoveParameter')}</Button></div>
            {parameterType === 'string' ? <div className="grid gap-2 sm:grid-cols-2"><Field><FieldLabel htmlFor={`recipe-param-default-${index}`}>{t('recipeParameterDefault')}</FieldLabel><Input id={`recipe-param-default-${index}`} value={String(parameter.default ?? '')} onChange={(e) => updateParameter(index, { default: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-param-max-${index}`}>{t('recipeParameterMaximumLength')}</FieldLabel><Input id={`recipe-param-max-${index}`} type="number" min="1" max="4000" value={String(parameter.maxLength ?? 4000)} onChange={(e) => updateParameter(index, { maxLength: Number(e.target.value) })} /></Field></div> : null}
            {parameterType === 'string_list' ? <div className="grid gap-2 sm:grid-cols-2"><Field><FieldLabel htmlFor={`recipe-param-default-${index}`}>{t('recipeParameterDefault')}</FieldLabel><Textarea id={`recipe-param-default-${index}`} rows={2} value={Array.isArray(parameter.default) ? parameter.default.join('\n') : ''} onChange={(e) => updateParameter(index, { default: e.target.value.split('\n').filter(Boolean) })} /></Field><Field><FieldLabel htmlFor={`recipe-param-max-${index}`}>{t('recipeParameterMaximumItems')}</FieldLabel><Input id={`recipe-param-max-${index}`} type="number" min="1" max="40" value={String(parameter.maxItems ?? 40)} onChange={(e) => updateParameter(index, { maxItems: Number(e.target.value) })} /></Field></div> : null}
            {parameterType === 'integer' ? <div className="grid gap-2 sm:grid-cols-3">{(['minimum', 'maximum', 'default'] as const).map((key) => <Field key={key}><FieldLabel htmlFor={`recipe-param-${key}-${index}`}>{t(key === 'default' ? 'recipeParameterDefault' : key === 'minimum' ? 'recipeParameterMinimum' : 'recipeParameterMaximum')}</FieldLabel><Input id={`recipe-param-${key}-${index}`} type="number" value={String(parameter[key] ?? '')} onChange={(e) => updateParameter(index, { [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>)}</div> : null}
            {parameterType === 'boolean' ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={parameter.default === true} onChange={(e) => updateParameter(index, { default: e.target.checked })} />{t('recipeParameterDefaultTrue')}</label> : null}
            {parameterType === 'enum' ? <div className="grid gap-2 sm:grid-cols-2"><Field><FieldLabel htmlFor={`recipe-param-options-${index}`}>{t('recipeParameterOptions')}</FieldLabel><Textarea id={`recipe-param-options-${index}`} rows={2} value={Array.isArray(parameter.options) ? parameter.options.join('\n') : ''} onChange={(e) => updateParameter(index, { options: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} /></Field><Field><FieldLabel htmlFor={`recipe-param-default-${index}`}>{t('recipeParameterDefault')}</FieldLabel><Input id={`recipe-param-default-${index}`} value={String(parameter.default ?? '')} onChange={(e) => updateParameter(index, { default: e.target.value })} /></Field></div> : null}
          </div>
        })}
      </section>
      <section className="grid gap-3" aria-label={t('recipeAcceptanceConditions')}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t('recipeAcceptanceConditions')}</h4><Button type="button" size="sm" variant="outline" onClick={addCondition}>{t('recipeAddCondition')}</Button></div>
        {conditions.map((condition, index) => {
          const checker = condition.checker && typeof condition.checker === 'object' ? condition.checker as Record<string, unknown> : {}
          return <div key={`${index}:${String(condition.id ?? '')}`} className="grid gap-3 rounded-lg border p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <Field><FieldLabel htmlFor={`recipe-condition-id-${index}`}>{t('recipeConditionId')}</FieldLabel><Input id={`recipe-condition-id-${index}`} value={String(condition.id ?? '')} onChange={(e) => updateCondition(index, { id: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor={`recipe-condition-statement-${index}`}>{t('recipeConditionStatement')}</FieldLabel><Input id={`recipe-condition-statement-${index}`} value={String(condition.statement ?? '')} onChange={(e) => updateCondition(index, { statement: e.target.value })} /></Field>
            <div className="flex items-end justify-between gap-2 sm:justify-end"><label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={condition.required !== false} onChange={(e) => updateCondition(index, { required: e.target.checked })} />{t('recipeRequired')}</label><Button type="button" size="sm" variant="ghost" disabled={conditions.length <= 1} aria-label={`${t('recipeRemoveCondition')} ${index + 1}`} onClick={() => removeCondition(index)}>{t('recipeRemoveCondition')}</Button></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field><FieldLabel htmlFor={`recipe-checker-kind-${index}`}>{t('recipeChecker')}</FieldLabel><select id={`recipe-checker-kind-${index}`} className="h-9 rounded-lg border bg-background px-2 text-sm" value={String(checker.kind ?? 'approval')} onChange={(e) => setCheckerKind(index, e.target.value)}>{['approval', 'file', 'command', 'citations', 'diff', 'review', 'effect'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></Field>
              {checker.kind === 'approval' ? <Field><FieldLabel htmlFor={`recipe-checker-prompt-${index}`}>{t('recipeCheckerPrompt')}</FieldLabel><Input id={`recipe-checker-prompt-${index}`} value={String(checker.prompt ?? '')} onChange={(e) => updateChecker(index, { ...checker, prompt: e.target.value })} /></Field> : null}
              {checker.kind === 'file' ? <><Field><FieldLabel htmlFor={`recipe-checker-path-${index}`}>{t('recipeCheckerPath')}</FieldLabel><Input id={`recipe-checker-path-${index}`} value={String(checker.path ?? '')} onChange={(e) => updateChecker(index, { ...checker, path: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-checker-assert-${index}`}>{t('recipeCheckerAssertion')}</FieldLabel><select id={`recipe-checker-assert-${index}`} className="h-9 rounded-lg border bg-background px-2 text-sm" value={typeof checker.assert === 'string' ? checker.assert : 'contains'} onChange={(e) => updateChecker(index, { ...checker, assert: e.target.value === 'contains' ? { contains: '' } : e.target.value })}><option value="exists">exists</option><option value="absent">absent</option><option value="contains">contains</option></select>{typeof checker.assert === 'object' && checker.assert !== null ? <Input aria-label={t('recipeCheckerContains')} value={String((checker.assert as Record<string, unknown>).contains ?? '')} onChange={(e) => updateChecker(index, { ...checker, assert: { contains: e.target.value } })} /> : null}</Field></> : null}
              {checker.kind === 'command' ? <Field><FieldLabel htmlFor={`recipe-checker-command-${index}`}>{t('recipeCheckerCommand')}</FieldLabel><Input id={`recipe-checker-command-${index}`} value={String(checker.commandId ?? '')} onChange={(e) => updateChecker(index, { ...checker, commandId: e.target.value })} /></Field> : null}
              {checker.kind === 'citations' ? <><Field><FieldLabel htmlFor={`recipe-checker-citations-file-${index}`}>{t('recipeCheckerFile')}</FieldLabel><Input id={`recipe-checker-citations-file-${index}`} value={String(checker.file ?? '')} onChange={(e) => updateChecker(index, { ...checker, file: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-checker-citations-min-${index}`}>{t('recipeCheckerMinimum')}</FieldLabel><Input id={`recipe-checker-citations-min-${index}`} type="number" min="1" max="50" value={String(checker.min ?? 1)} onChange={(e) => updateChecker(index, { ...checker, min: Number(e.target.value) })} /></Field></> : null}
              {checker.kind === 'diff' ? <><Field><FieldLabel htmlFor={`recipe-checker-diff-require-${index}`}>{t('recipeCheckerRequire')}</FieldLabel><Textarea id={`recipe-checker-diff-require-${index}`} rows={2} value={Array.isArray(checker.require) ? checker.require.join('\n') : ''} onChange={(e) => updateChecker(index, { ...checker, require: e.target.value.split('\n').filter(Boolean) })} /></Field><Field><FieldLabel htmlFor={`recipe-checker-diff-forbid-${index}`}>{t('recipeCheckerForbid')}</FieldLabel><Textarea id={`recipe-checker-diff-forbid-${index}`} rows={2} value={Array.isArray(checker.forbid) ? checker.forbid.join('\n') : ''} onChange={(e) => updateChecker(index, { ...checker, forbid: e.target.value.split('\n').filter(Boolean) })} /></Field></> : null}
              {checker.kind === 'review' ? <><Field><FieldLabel htmlFor={`recipe-checker-review-profile-${index}`}>{t('recipeCheckerProfile')}</FieldLabel><Input id={`recipe-checker-review-profile-${index}`} value={String(checker.profile ?? '')} onChange={(e) => updateChecker(index, { ...checker, profile: e.target.value })} /></Field><Field><FieldLabel htmlFor={`recipe-checker-review-rubric-${index}`}>{t('recipeCheckerRubric')}</FieldLabel><Textarea id={`recipe-checker-review-rubric-${index}`} rows={2} value={String(checker.rubric ?? '')} onChange={(e) => updateChecker(index, { ...checker, rubric: e.target.value })} /></Field></> : null}
              {checker.kind === 'effect' ? <p className="text-xs text-muted-foreground">{t('recipeEffectCheckerJsonNote')}</p> : null}
            </div>
          </div>
        })}
      </section>
      <div className="rounded-lg bg-muted/50 p-3 text-xs">
        <p className="font-semibold">{t('recipePreview')}</p>
        <p className="mt-1">{String(workflow.title ?? doc.title ?? '—')} · {String(doc.category ?? '—')} · {String(doc.startPolicy ?? 'human_approval')}</p>
        <p className="mt-1">{Array.isArray(workflow.goals) ? workflow.goals.join(' · ') : ''}</p>
        <ul className="mt-2 grid gap-1">{conditions.map((condition, index) => <li key={`${index}:${String(condition.id ?? '')}`}>{String(condition.id ?? '—')}: {String(condition.statement ?? '—')}</li>)}</ul>
        <p className="mt-1 text-muted-foreground">{t('recipePreviewNote')}</p>
      </div>
    </section>
  )
}

function SkillCurationPanel({ caseText, setCaseText, outputText, setOutputText, evaluation, evaluating, onEvaluate, history, currentDigest, rollbackReason, setRollbackReason, onRollback, busy }: {
  caseText: string; setCaseText: (value: string) => void
  outputText: string; setOutputText: (value: string) => void
  evaluation: Evaluation | null; evaluating: boolean; onEvaluate: (split: 'dev' | 'holdout') => void; history: SkillHistory[]; currentDigest: string | null
  rollbackReason: string; setRollbackReason: (value: string) => void; onRollback: (digest: string) => void; busy: boolean
}) {
  const { t } = useI18n()
  return (
    <section className="grid gap-3 rounded-xl border p-4" aria-label={t('skillCuration')}>
      <div><h3 className="font-semibold">{t('skillCuration')}</h3><p className="text-xs text-muted-foreground">{t('skillCurationNote')}</p></div>
      <Field><FieldLabel htmlFor="skill-cases">{t('skillCasesJson')}</FieldLabel><Textarea id="skill-cases" rows={5} className="font-mono text-xs" value={caseText} onChange={(e) => setCaseText(e.target.value)} /></Field>
      <Field><FieldLabel htmlFor="skill-outputs">{t('skillOutputsJson')}</FieldLabel><Textarea id="skill-outputs" rows={7} className="font-mono text-xs" value={outputText} onChange={(e) => setOutputText(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={evaluating} onClick={() => onEvaluate('dev')}>{evaluating ? t('skillEvaluating') : t('skillEvaluateDev')}</Button><Button variant="outline" disabled={evaluating} onClick={() => onEvaluate('holdout')}>{evaluating ? t('skillEvaluating') : t('skillEvaluateHoldout')}</Button></div>
      {evaluation ? <div role="status" className="grid gap-2 rounded-lg border p-3 text-sm"><p className={evaluation.eligible ? 'text-status-done' : 'text-destructive'}>{evaluation.eligible ? t('skillEvaluationPassed') : t('skillEvaluationFailed')} · {evaluation.checks.filter((check) => check.passed).length}/{evaluation.checks.length}</p><ul className="grid gap-1 text-xs">{evaluation.checks.map((check) => <li key={`${check.caseId}:${check.repetition}`}>{check.caseId} · {t('skillRepetition')} {check.repetition} · {check.passed ? 'PASS' : 'FAIL'}</li>)}</ul><p className="text-xs text-muted-foreground">{t('skillManualAdmission')}</p></div> : null}
      {history.length > 0 ? <div className="grid gap-2 border-t pt-3"><h4 className="text-sm font-semibold">{t('libraryHistory')}</h4><Field><FieldLabel htmlFor="rollback-reason">{t('libraryRollbackReason')}</FieldLabel><Input id="rollback-reason" value={rollbackReason} onChange={(e) => setRollbackReason(e.target.value)} /></Field>{history.slice().reverse().map((entry) => <div key={`${entry.seq}:${entry.digest}`} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>#{entry.seq} · {entry.operation} · <code>{entry.digest.slice(7, 19)}</code>{entry.reason ? ` · ${entry.reason}` : ''}</span>{entry.digest !== currentDigest && entry.operation !== 'DELETE' ? <Button size="sm" variant="outline" disabled={busy || !rollbackReason.trim()} onClick={() => onRollback(entry.digest)}>{t('libraryRollback')}</Button> : null}</div>)}</div> : null}
    </section>
  )
}
