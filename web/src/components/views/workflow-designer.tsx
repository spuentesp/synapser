// Workflow designer (plan 14 Q3.1). A form that builds a Workflow document, asks the SERVER's validator about it as
// the person types (the check writes nothing), and saves only a document that validator accepts. The JSON preview is
// exactly what gets saved.
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { type Key, useI18n } from '@/lib/i18n'
import { ErrorNote } from './common'
import { TEMPLATES } from './workflow-templates'

// The checker kinds a condition may use (model.ts, Checker): seven choices, so a Select rather than a ToggleGroup.
const KINDS = ['diff', 'command', 'citations', 'file', 'approval', 'review', 'effect'] as const
type Kind = (typeof KINDS)[number]
const KIND_KEY: Record<Kind, Key> = { diff: 'checkerDiff', command: 'checkerCommand', citations: 'checkerCitations', file: 'checkerFile', approval: 'checkerApproval', review: 'checkerReview', effect: 'checkerEffect' }

/** One condition as the form holds it: every checker's fields side by side; only the chosen kind's are used. */
export interface CondDraft {
  key: number
  id: string
  statement: string
  required: boolean
  kind: Kind
  commandId: string
  require: string
  forbid: string
  file: string
  min: string
  assert: 'exists' | 'absent' | 'contains'
  contains: string
  prompt: string
  profile: string
  rubric: string
  effectKind: string
  params: string
}

export interface Draft {
  title: string
  description: string
  goals: string
  nonGoals: string
  conditions: CondDraft[]
  budgetUsd: string
  budgetMinutes: string
}

/** The stored shape the designer edits: a loose view of model.ts's Workflow. The server validates for real. */
export interface WorkflowDoc {
  id?: string
  title: string
  description: string
  goals?: string[]
  nonGoals?: { statement: string; guard?: Record<string, unknown> }[]
  conditions: { id: string; statement: string; required: boolean; checker: Record<string, unknown> }[]
  budget?: { usd?: number; minutes?: number }
}

const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter((x) => x.length > 0)
let keySeq = 1
const blankCond = (id: string): CondDraft => ({ key: keySeq++, id, statement: '', required: true, kind: 'diff', commandId: '', require: '', forbid: '', file: '', min: '1', assert: 'exists', contains: '', prompt: '', profile: '', rubric: '', effectKind: '', params: '{}' })
const freshId = (conds: CondDraft[]): string => {
  let n = conds.length + 1
  while (conds.some((c) => c.id === `c${n}`)) n++
  return `c${n}`
}

export const emptyDraft = (): Draft => ({ title: '', description: '', goals: '', nonGoals: '', conditions: [blankCond('c1')], budgetUsd: '', budgetMinutes: '' })

/** The form state of a stored workflow, so a draft can be edited with the same designer. */
export function draftOf(w: WorkflowDoc): Draft {
  return {
    title: w.title,
    description: w.description,
    goals: (w.goals ?? []).join('\n'),
    nonGoals: (w.nonGoals ?? []).map((n) => n.statement).join('\n'),
    conditions: w.conditions.map((c) => {
      const k = c.checker
      const kind = (KINDS as readonly string[]).includes(String(k['kind'])) ? (k['kind'] as Kind) : 'diff'
      const base = { ...blankCond(c.id), statement: c.statement, required: c.required, kind }
      switch (kind) {
        case 'diff':
          return { ...base, require: ((k['require'] as string[] | undefined) ?? []).join('\n'), forbid: ((k['forbid'] as string[] | undefined) ?? []).join('\n') }
        case 'command':
          return { ...base, commandId: String(k['commandId'] ?? '') }
        case 'citations':
          return { ...base, file: String(k['file'] ?? ''), min: String(k['min'] ?? '1') }
        case 'file': {
          const a = k['assert']
          const assert = typeof a === 'object' && a !== null ? 'contains' : a === 'absent' ? 'absent' : 'exists'
          return { ...base, file: String(k['path'] ?? ''), assert, contains: typeof a === 'object' && a !== null ? String((a as { contains?: unknown }).contains ?? '') : '' }
        }
        case 'approval':
          return { ...base, prompt: String(k['prompt'] ?? '') }
        case 'review':
          return { ...base, profile: String(k['profile'] ?? ''), rubric: String(k['rubric'] ?? '') }
        case 'effect':
          return { ...base, effectKind: String(k['effectKind'] ?? ''), params: JSON.stringify(k['params'] ?? {}, null, 2) }
      }
    }),
    budgetUsd: w.budget?.usd !== undefined ? String(w.budget.usd) : '',
    budgetMinutes: w.budget?.minutes !== undefined ? String(w.budget.minutes) : '',
  }
}

function checkerOf(c: CondDraft): Record<string, unknown> | null {
  switch (c.kind) {
    case 'diff':
      return { kind: 'diff', ...(lines(c.require).length ? { require: lines(c.require) } : {}), ...(lines(c.forbid).length ? { forbid: lines(c.forbid) } : {}) }
    case 'command':
      return { kind: 'command', commandId: c.commandId }
    case 'citations':
      return { kind: 'citations', file: c.file, min: Number(c.min) }
    case 'file':
      return { kind: 'file', path: c.file, assert: c.assert === 'contains' ? { contains: c.contains } : c.assert }
    case 'approval':
      return { kind: 'approval', prompt: c.prompt }
    case 'review':
      return { kind: 'review', profile: c.profile, rubric: c.rubric }
    case 'effect':
      try {
        return { kind: 'effect', effectKind: c.effectKind, params: JSON.parse(c.params) as unknown }
      } catch {
        return null
      }
  }
}

/** The document the form stands for, and the conditions whose parameters are not valid JSON yet. */
export function documentOf(d: Draft, guards: ReadonlyMap<string, Record<string, unknown>>): { doc: Record<string, unknown>; badParams: number[] } {
  const badParams: number[] = []
  const conditions = d.conditions.map((c, i) => {
    const checker = checkerOf(c)
    if (checker === null) badParams.push(i)
    return { id: c.id, statement: c.statement, required: c.required, checker: checker ?? {} }
  })
  const budget: { usd?: number; minutes?: number } = {}
  if (d.budgetUsd.trim()) budget.usd = Number(d.budgetUsd)
  if (d.budgetMinutes.trim()) budget.minutes = Number(d.budgetMinutes)
  const doc = {
    title: d.title,
    description: d.description,
    goals: lines(d.goals),
    // a non-goal guard is not editable here: it is kept for the statement it belongs to
    nonGoals: lines(d.nonGoals).map((statement) => {
      const guard = guards.get(statement)
      return guard ? { statement, guard } : { statement }
    }),
    conditions,
    ...(Object.keys(budget).length ? { budget } : {}),
  }
  return { doc, badParams }
}

interface Check {
  ok: boolean
  errors: string[]
}

/** The non-goal guards a document carries, by statement: the form keeps them although it cannot edit them. */
const guardsOf = (d: { nonGoals?: { statement: string; guard?: Record<string, unknown> }[] } | null): Map<string, Record<string, unknown>> =>
  new Map((d?.nonGoals ?? []).flatMap((n) => (n.guard ? [[n.statement, n.guard] as const] : [])))

export function WorkflowDesigner({ session, initial, editingId, onSaved, onCancel }: { session: boolean; initial: WorkflowDoc | null; editingId: string | null; onSaved: (id: string) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftOf(initial) : emptyDraft()))
  const [guards, setGuards] = useState<Map<string, Record<string, unknown>>>(() => guardsOf(initial))
  // a built-in template fills the form with its parameters (plan 14 Q3.2); the person adjusts it before saving
  const [tpl, setTpl] = useState('')
  const [tplParams, setTplParams] = useState<Record<string, string>>({})
  const selectedTpl = TEMPLATES.find((x) => x.id === tpl) ?? null
  const applyTemplate = () => {
    if (!selectedTpl) return
    const doc = selectedTpl.build(tplParams)
    setDraft(draftOf(doc))
    setGuards(guardsOf(doc))
  }
  const [commands, setCommands] = useState<string[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<ApiError | null>(null)
  const { doc, badParams } = documentOf(draft, guards)
  const docJson = JSON.stringify(doc, null, 2)

  useEffect(() => {
    api<{ commands: string[] }>('/api/config').then((c) => setCommands(c.commands ?? []), () => setCommands([]))
    api<{ agents: { id: string }[] }>('/api/catalog').then((c) => setProfiles(c.agents.map((a) => a.id)), () => setProfiles([]))
  }, [])

  // live check against the server's validator; a slower earlier answer never overwrites a newer one
  useEffect(() => {
    if (!session || badParams.length > 0) return
    let stale = false
    setChecking(true)
    const timer = setTimeout(() => {
      api<{ ok: boolean; errors?: string[] }>('/api/designer/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: docJson })
        .then((r) => { if (!stale) setCheck({ ok: r.ok, errors: r.errors ?? [] }) }, (e: Error) => { if (!stale) setCheck({ ok: false, errors: [e.message] }) })
        .finally(() => { if (!stale) setChecking(false) })
    }, 400)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [docJson, session, badParams.length])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const setCond = (key: number, patch: Partial<CondDraft>) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c) => (c.key === key ? { ...c, ...patch } : c)) }))
  const addCond = () => setDraft((d) => ({ ...d, conditions: [...d.conditions, blankCond(freshId(d.conditions))] }))
  const removeCond = (key: number) => setDraft((d) => ({ ...d, conditions: d.conditions.filter((c) => c.key !== key) }))

  const save = () => {
    if (!session) return
    setSaving(true)
    setSaveError(null)
    const headers = { 'content-type': 'application/json' }
    const saved = editingId
      ? api<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(editingId)}`, { method: 'PUT', headers, body: JSON.stringify({ ...doc, id: editingId }) }).then(() => editingId)
      : api<{ ok: boolean; id: string }>('/api/workflows', { method: 'POST', headers, body: docJson }).then((r) => r.id)
    saved.then(onSaved, (e: ApiError) => setSaveError(e)).finally(() => setSaving(false))
  }

  const problems = badParams.length > 0 ? [t('designerInvalidParams')] : check && !check.ok ? check.errors : []
  const canSave = session && !saving && !checking && badParams.length === 0 && check?.ok === true

  const kindFields = (c: CondDraft) => {
    switch (c.kind) {
      case 'diff':
        return (
          <>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-require`}>{t('designerRequire')}</FieldLabel>
              <Textarea id={`cond-${c.key}-require`} rows={2} value={c.require} onChange={(e) => setCond(c.key, { require: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-forbid`}>{t('designerForbid')}</FieldLabel>
              <Textarea id={`cond-${c.key}-forbid`} rows={2} value={c.forbid} onChange={(e) => setCond(c.key, { forbid: e.target.value })} />
            </Field>
          </>
        )
      case 'command':
        return (
          <Field>
            <FieldLabel>{t('designerCommand')}</FieldLabel>
            <Select value={c.commandId} onValueChange={(v) => v && setCond(c.key, { commandId: v })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent><SelectGroup>{commands.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            {commands.length === 0 ? <FieldDescription>{t('designerNoCommands')}</FieldDescription> : null}
          </Field>
        )
      case 'citations':
        return (
          <>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-file`}>{t('designerFile')}</FieldLabel>
              <Input id={`cond-${c.key}-file`} value={c.file} onChange={(e) => setCond(c.key, { file: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-min`}>{t('designerMin')}</FieldLabel>
              <Input id={`cond-${c.key}-min`} type="number" min={1} max={50} value={c.min} onChange={(e) => setCond(c.key, { min: e.target.value })} />
            </Field>
          </>
        )
      case 'file':
        return (
          <>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-file`}>{t('designerFile')}</FieldLabel>
              <Input id={`cond-${c.key}-file`} value={c.file} onChange={(e) => setCond(c.key, { file: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel>{t('designerAssert')}</FieldLabel>
              <Select value={c.assert} onValueChange={(v) => v && setCond(c.key, { assert: v as CondDraft['assert'] })}>
                <SelectTrigger className="w-full"><SelectValue>{(v: CondDraft['assert'] | null) => (v === 'absent' ? t('assertAbsent') : v === 'contains' ? t('assertContains') : t('assertExists'))}</SelectValue></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="exists">{t('assertExists')}</SelectItem>
                  <SelectItem value="absent">{t('assertAbsent')}</SelectItem>
                  <SelectItem value="contains">{t('assertContains')}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            {c.assert === 'contains' ? (
              <Field>
                <FieldLabel htmlFor={`cond-${c.key}-contains`}>{t('designerContains')}</FieldLabel>
                <Input id={`cond-${c.key}-contains`} value={c.contains} onChange={(e) => setCond(c.key, { contains: e.target.value })} />
              </Field>
            ) : null}
          </>
        )
      case 'approval':
        return (
          <Field>
            <FieldLabel htmlFor={`cond-${c.key}-prompt`}>{t('designerPrompt')}</FieldLabel>
            <Input id={`cond-${c.key}-prompt`} value={c.prompt} onChange={(e) => setCond(c.key, { prompt: e.target.value })} />
          </Field>
        )
      case 'review':
        return (
          <>
            <Field>
              <FieldLabel>{t('designerProfile')}</FieldLabel>
              <Select value={c.profile} onValueChange={(v) => v && setCond(c.key, { profile: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent><SelectGroup>{profiles.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-rubric`}>{t('designerRubric')}</FieldLabel>
              <Textarea id={`cond-${c.key}-rubric`} rows={2} value={c.rubric} onChange={(e) => setCond(c.key, { rubric: e.target.value })} />
            </Field>
          </>
        )
      case 'effect': {
        const badJson = checkerOf(c) === null
        return (
          <>
            <Field>
              <FieldLabel htmlFor={`cond-${c.key}-effect`}>{t('designerEffectKind')}</FieldLabel>
              <Input id={`cond-${c.key}-effect`} value={c.effectKind} onChange={(e) => setCond(c.key, { effectKind: e.target.value })} />
            </Field>
            <Field data-invalid={badJson || undefined}>
              <FieldLabel htmlFor={`cond-${c.key}-params`}>{t('designerParams')}</FieldLabel>
              <Textarea id={`cond-${c.key}-params`} aria-invalid={badJson || undefined} className="font-mono text-xs" rows={3} value={c.params} onChange={(e) => setCond(c.key, { params: e.target.value })} />
            </Field>
          </>
        )
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(editingId ? 'designerEdit' : 'designerNew')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        {!editingId ? (
          <section className="grid gap-3 rounded-xl border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tplTitle')}</h3>
            <FieldGroup>
              <Field>
                <FieldLabel>{t('tplChoose')}</FieldLabel>
                <Select value={tpl} onValueChange={(v) => { if (v) { setTpl(v); setTplParams({}) } }}>
                  <SelectTrigger className="w-full"><SelectValue>{(v: string | null) => (v ? t(TEMPLATES.find((x) => x.id === v)?.title ?? 'tplTitle') : '—')}</SelectValue></SelectTrigger>
                  <SelectContent><SelectGroup>{TEMPLATES.map((x) => <SelectItem key={x.id} value={x.id}>{t(x.title)}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                {selectedTpl ? <FieldDescription>{t(selectedTpl.description)}</FieldDescription> : null}
              </Field>
              {selectedTpl?.params.map((p) => (
                <Field key={p.name}>
                  <FieldLabel htmlFor={`tpl-${p.name}`}>{t(p.label)}</FieldLabel>
                  {p.multiline ? (
                    <Textarea id={`tpl-${p.name}`} rows={2} value={tplParams[p.name] ?? ''} onChange={(e) => setTplParams((x) => ({ ...x, [p.name]: e.target.value }))} />
                  ) : (
                    <Input id={`tpl-${p.name}`} value={tplParams[p.name] ?? ''} onChange={(e) => setTplParams((x) => ({ ...x, [p.name]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </FieldGroup>
            {selectedTpl ? (
              <div>
                <Button size="sm" variant="outline" onClick={applyTemplate}>{t('tplApply')}</Button>
              </div>
            ) : null}
          </section>
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="wf-title">{t('designerTitleField')}</FieldLabel>
            <Input id="wf-title" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wf-description">{t('designerDescriptionField')}</FieldLabel>
            <Textarea id="wf-description" rows={3} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wf-goals">{t('designerGoals')}</FieldLabel>
            <Textarea id="wf-goals" rows={3} value={draft.goals} onChange={(e) => set({ goals: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wf-nongoals">{t('designerNonGoals')}</FieldLabel>
            <Textarea id="wf-nongoals" rows={2} value={draft.nonGoals} onChange={(e) => set({ nonGoals: e.target.value })} />
          </Field>
        </FieldGroup>

        <section className="grid gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('designerConditions')}</h3>
          {draft.conditions.map((c) => (
            <Card key={c.key}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-mono">{c.id}</span>
                  <Button variant="ghost" size="sm" aria-label={t('designerRemoveCondition')} disabled={draft.conditions.length === 1} onClick={() => removeCond(c.key)}>
                    <Trash2 data-icon="inline-start" />
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                    <Field>
                      <FieldLabel htmlFor={`cond-${c.key}-id`}>id</FieldLabel>
                      <Input id={`cond-${c.key}-id`} className="font-mono" value={c.id} onChange={(e) => setCond(c.key, { id: e.target.value })} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`cond-${c.key}-statement`}>{t('designerStatement')}</FieldLabel>
                      <Input id={`cond-${c.key}-statement`} value={c.statement} onChange={(e) => setCond(c.key, { statement: e.target.value })} />
                    </Field>
                  </div>
                  <Field orientation="horizontal">
                    <Switch id={`cond-${c.key}-required`} checked={c.required} onCheckedChange={(v) => setCond(c.key, { required: v })} />
                    <FieldLabel htmlFor={`cond-${c.key}-required`}>{t('designerRequired')}</FieldLabel>
                  </Field>
                  <Field>
                    <FieldLabel>{t('designerChecker')}</FieldLabel>
                    <Select value={c.kind} onValueChange={(v) => v && setCond(c.key, { kind: v as Kind })}>
                      <SelectTrigger className="w-full"><SelectValue>{(v: Kind | null) => (v ? t(KIND_KEY[v]) : '—')}</SelectValue></SelectTrigger>
                      <SelectContent><SelectGroup>{KINDS.map((k) => <SelectItem key={k} value={k}>{t(KIND_KEY[k])}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                  </Field>
                  {kindFields(c)}
                </FieldGroup>
              </CardContent>
            </Card>
          ))}
          <div>
            <Button variant="outline" size="sm" onClick={addCond}>{t('designerAddCondition')}</Button>
          </div>
        </section>

        <FieldGroup>
          <Field>
            <FieldLabel>{t('designerBudget')}</FieldLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input type="number" min={0} step="any" aria-label={t('usd')} value={draft.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value })} />
              <Input type="number" min={0} step="any" aria-label={t('designerMinutes')} value={draft.budgetMinutes} onChange={(e) => set({ budgetMinutes: e.target.value })} />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="wf-preview">{t('designerPreview')}</FieldLabel>
            <Textarea id="wf-preview" readOnly rows={12} className="font-mono text-xs" value={docJson} />
          </Field>
        </FieldGroup>

        {checking ? <p className="text-xs text-muted-foreground">{t('designerChecking')}</p> : null}
        {problems.length > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="grid list-disc gap-1 pl-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </AlertDescription>
          </Alert>
        ) : check?.ok ? (
          <Alert>
            <AlertDescription>{t('designerValid')}</AlertDescription>
          </Alert>
        ) : null}
        {saveError ? <ErrorNote code={saveError.code} /> : null}
        {saveError && saveError.errors.length > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="grid list-disc gap-1 pl-4">{saveError.errors.map((p) => <li key={p}>{p}</li>)}</ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        <Button disabled={!canSave} onClick={save}>{t('saveDraft')}</Button>
        <Button variant="outline" onClick={onCancel}>{t('designerCancel')}</Button>
        {!session ? <p className="text-xs text-destructive">{t('designerNoSession')}</p> : null}
      </CardFooter>
    </Card>
  )
}
