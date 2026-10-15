// Agent designer (plan 14 Q3.3). A form over the same document the JSON editor holds: each change writes the document back,
// and the server still decides what is valid. It shows the two cases of plan 15 IC1, and what the operator's file keeps.
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/lib/i18n'

/** A profile a library agent may extend, as the server reports it. */
export interface Base {
  id: string
  adapter: string
  role: string
  tier: string
  permissions: { mode?: string; allowedTools?: readonly string[]; disallowedTools?: readonly string[] } | null
  maxBudgetUsd: number | null
  enabledByFile: boolean
  pool: string | null
  provider: string | null
}

interface Props {
  text: string
  onChange: (doc: Record<string, unknown>) => void
  bases: Base[]
  providerIds: string[]
  fileOnly: string[]
  skillsByAgent: Record<string, string[]>
}

const TIERS = ['cheap', 'standard', 'advanced'] as const
const NONE = '__none__'

/** The document the editor holds, when it is a JSON object. */
function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A copy of the document with the patch applied. An empty value removes its key, so the document never carries blanks. */
function withPatch(doc: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...doc }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '' || (typeof value === 'number' && Number.isNaN(value))) delete next[key]
    else next[key] = value
  }
  return next
}

function without(doc: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const next = { ...doc }
  for (const key of keys) delete next[key]
  return next
}

const tagsOf = (doc: Record<string, unknown>): string => (Array.isArray(doc.tags) ? (doc.tags as string[]).join(', ') : '')
const parseTags = (raw: string): string[] => raw.split(',').map((s) => s.trim()).filter(Boolean)

export function LibraryAgentDesigner({ text, onChange, bases, providerIds, fileOnly, skillsByAgent }: Props) {
  const { t } = useI18n()
  const doc = parse(text)
  // a tag list being typed keeps its commas until the document changes under it
  const [tagsDraft, setTagsDraft] = useState(() => (doc ? tagsOf(doc) : ''))
  useEffect(() => {
    if (!doc) return
    const current = Array.isArray(doc.tags) ? doc.tags : []
    if (JSON.stringify(parseTags(tagsDraft)) !== JSON.stringify(current)) setTagsDraft(tagsOf(doc))
  }, [text, tagsDraft])

  if (!doc) return <Alert variant="destructive"><AlertDescription>{t('libraryJsonBroken')}</AlertDescription></Alert>

  const extending = typeof doc.extends === 'string'
  const selectedBase = extending ? bases.find((base) => base.id === doc.extends) : undefined
  const assignedSkills = typeof doc.id === 'string' ? skillsByAgent[doc.id] ?? [] : []
  const set = (patch: Record<string, unknown>) => onChange(withPatch(doc, patch))
  // the two cases of plan 15 IC1: each one drops the fields that belong to the other
  const toExtends = () => onChange(withPatch(without(doc, ['adapter', 'role', 'nativeRole']), { extends: bases[0]?.id ?? '' }))
  const toNative = () => onChange(withPatch(without(doc, ['extends']), { adapter: 'native', role: typeof doc.role === 'string' ? doc.role : 'writer' }))

  return (
    <div className="grid gap-4">
      <p className="text-sm font-semibold">{t('libraryDesigner')}</p>
      <Tabs value={extending ? 'extends' : 'native'} onValueChange={(v) => (v === 'extends' ? toExtends() : toNative())}>
        <TabsList>
          <TabsTrigger value="extends">{t('libraryModeExtends')}</TabsTrigger>
          <TabsTrigger value="native">{t('libraryModeNative')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <FieldGroup>
        {extending ? (
          <Field>
            <FieldLabel>{t('libraryBase')}</FieldLabel>
            <Select value={typeof doc.extends === 'string' && doc.extends ? doc.extends : ''} onValueChange={(v) => v && set({ extends: v })}>
              <SelectTrigger className="w-full"><SelectValue>{typeof doc.extends === 'string' ? doc.extends : '—'}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {bases.map((b) => (
                    <SelectItem key={b.id} value={b.id} disabled={Boolean(b.pool)}>
                      {`${b.id} · ${b.enabledByFile ? t('libraryBaseEnabled') : t('libraryBaseDisabled')}${b.pool ? ` · ${t('libraryBasePooled')}` : ''}`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field>
          <FieldLabel>{t('libraryProvider')}</FieldLabel>
          <Select value={typeof doc.provider === 'string' && doc.provider ? doc.provider : NONE} onValueChange={(v) => set({ provider: v === NONE ? undefined : v })}>
            <SelectTrigger className="w-full"><SelectValue>{typeof doc.provider === 'string' && doc.provider ? doc.provider : '—'}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>—</SelectItem>
                {providerIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          {providerIds.length === 0 ? <FieldDescription>{t('libraryNoProviders')}</FieldDescription> : null}
        </Field>
        {extending && selectedBase ? (
          <div className="grid gap-2 rounded-xl border p-3" data-agent-inherited-controls>
            <p className="text-sm font-semibold">{t('libraryInheritedControls')}</p>
            <p className="text-xs text-muted-foreground">{t('libraryInheritedControlsNote')}</p>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div><dt className="text-muted-foreground">{t('libraryAdapter')}</dt><dd className="font-mono">{selectedBase.adapter}</dd></div>
              <div><dt className="text-muted-foreground">{t('libraryRole')}</dt><dd>{selectedBase.role}</dd></div>
              <div><dt className="text-muted-foreground">{t('libraryTier')}</dt><dd>{typeof doc.tier === 'string' ? doc.tier : selectedBase.tier}</dd></div>
              <div><dt className="text-muted-foreground">{t('libraryPermissions')}</dt><dd>{selectedBase.permissions ? JSON.stringify(selectedBase.permissions) : t('libraryNoCliPermissions')}</dd></div>
              <div><dt className="text-muted-foreground">{t('libraryBudget')}</dt><dd>{selectedBase.maxBudgetUsd === null ? t('libraryNoCliBudget') : `$${selectedBase.maxBudgetUsd} USD`}</dd></div>
              <div><dt className="text-muted-foreground">{t('libraryPool')}</dt><dd>{selectedBase.pool ?? t('libraryNoPool')}</dd></div>
            </dl>
          </div>
        ) : null}
        <Field>
          <FieldLabel htmlFor="agent-model">{t('libraryModel')}</FieldLabel>
          <Input id="agent-model" className="font-mono" value={typeof doc.model === 'string' ? doc.model : ''} onChange={(e) => set({ model: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-temperature">{t('libraryTemperature')}</FieldLabel>
          <Input
            id="agent-temperature"
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={typeof doc.temperature === 'number' ? doc.temperature : ''}
            onChange={(e) => set({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
        {!extending ? (
          <>
            <Field>
              <FieldLabel>{t('libraryRole')}</FieldLabel>
              <Select value={typeof doc.role === 'string' ? doc.role : 'writer'} onValueChange={(v) => v && set({ role: v })}>
                <SelectTrigger className="w-full"><SelectValue>{typeof doc.role === 'string' ? doc.role : 'writer'}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="writer">writer</SelectItem>
                    <SelectItem value="advisor">advisor</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t('libraryNativeRole')}</FieldLabel>
              <Select value={typeof doc.nativeRole === 'string' ? doc.nativeRole : NONE} onValueChange={(v) => set({ nativeRole: v === NONE ? undefined : v })}>
                <SelectTrigger className="w-full"><SelectValue>{typeof doc.nativeRole === 'string' ? doc.nativeRole : '—'}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>—</SelectItem>
                    <SelectItem value="worker">worker</SelectItem>
                    <SelectItem value="repair">repair</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor="agent-description">{t('libraryDescription')}</FieldLabel>
          <Input id="agent-description" value={typeof doc.description === 'string' ? doc.description : ''} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-tags">{t('libraryTags')}</FieldLabel>
          <Input
            id="agent-tags"
            value={tagsDraft}
            onChange={(e) => {
              setTagsDraft(e.target.value)
              set({ tags: parseTags(e.target.value) })
            }}
          />
        </Field>
        <Field>
          <FieldLabel>{t('libraryTier')}</FieldLabel>
          <Select value={typeof doc.tier === 'string' ? doc.tier : NONE} onValueChange={(v) => set({ tier: v === NONE ? undefined : v })}>
            <SelectTrigger className="w-full"><SelectValue>{typeof doc.tier === 'string' ? doc.tier : t('libraryTierInherit')}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>{t('libraryTierInherit')}</SelectItem>
                {TIERS.map((tier) => <SelectItem key={tier} value={tier}>{tier}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-timeout">{t('libraryTimeout')}</FieldLabel>
          <Input
            id="agent-timeout"
            type="number"
            min={1}
            max={3600000}
            value={typeof doc.timeoutMs === 'number' ? doc.timeoutMs : ''}
            onChange={(e) => set({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>{t('libraryEnabled')}</FieldLabel>
          <Switch checked={doc.enabled !== false} onCheckedChange={(checked) => set({ enabled: checked })} />
        </Field>
      </FieldGroup>
      {!extending ? <div className="grid gap-2 rounded-xl border p-3">
        <p className="text-sm font-semibold">{t('libraryNativeLimits')}</p>
        <p className="text-xs text-muted-foreground">{t('libraryNativeLimitsNote')}</p>
      </div> : null}
      <div className="grid gap-2 rounded-xl border p-3">
        <p className="text-sm font-semibold">{t('libraryFileControls')}</p>
        <p className="text-xs text-muted-foreground">{t('libraryFileControlsNote')}</p>
        <div className="flex flex-wrap gap-1">
          {fileOnly.map((field) => <Badge key={field} variant="outline">{t(`libraryField_${field}` as never)}</Badge>)}
        </div>
      </div>
      <div className="grid gap-2 rounded-xl border p-3" data-agent-skills>
        <p className="text-sm font-semibold">{t('libraryAssignedSkills')}</p>
        {assignedSkills.length ? <div className="flex flex-wrap gap-1">{assignedSkills.map((id) => <Badge key={id} variant="outline" className="font-mono">{id}</Badge>)}</div> : <p className="text-xs text-muted-foreground">{t('libraryNoAssignedSkills')}</p>}
        <p className="text-xs text-muted-foreground">{t('librarySkillsFromOperatorFile')}</p>
      </div>
    </div>
  )
}
