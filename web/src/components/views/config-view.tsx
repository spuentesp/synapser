import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

type Provider = {
  protocol: 'openai-compatible' | 'anthropic'
  baseUrl: string
  apiKeyEnv: string[]
  models: { id: string; usdPer1MIn?: number; usdPer1MOut?: number }[]
}
type Role = { provider: string; model: string; temperature: number; fallbacks?: string[] }
type OperatorConfig = { providers: Record<string, Provider>; roles: Record<string, Role> }
const SYSTEM_ROLES = ['supervisor', 'worker', 'repair', 'advisor', 'chat'] as const

const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean)
const joinLines = (value: string[] | undefined) => value?.join('\n') ?? ''

export function ConfigView({ session }: { session: boolean }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<OperatorConfig | null>(null)
  const [providerId, setProviderId] = useState('')
  const [roleId, setRoleId] = useState<(typeof SYSTEM_ROLES)[number]>('worker')
  const [providerDraft, setProviderDraft] = useState<Provider | null>(null)
  const [roleDraft, setRoleDraft] = useState<Role | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const response = await api<OperatorConfig>('/api/config')
    if (!response.providers || !response.roles) throw new Error(t('configInvalidJson'))
    setConfig(response)
    setProviderId((current) => current && response.providers[current] ? current : Object.keys(response.providers)[0] ?? 'new-provider')
    setRoleDraft(response.roles[roleId] ?? null)
  }
  useEffect(() => { void load().catch((e: Error) => setErrors([e.message])) }, [])

  useEffect(() => {
    if (!config) return
    const provider = config.providers[providerId]
    setProviderDraft(provider ? structuredClone(provider) : { protocol: 'openai-compatible', baseUrl: 'https://', apiKeyEnv: [], models: [] })
  }, [config, providerId])
  useEffect(() => { if (config) setRoleDraft(config.roles[roleId] ? structuredClone(config.roles[roleId]) : null) }, [config, roleId])

  const roleProviders = useMemo(() => Object.keys(config?.providers ?? {}).filter((id) => config?.providers[id]?.protocol === 'openai-compatible'), [config])
  const roleModels = roleDraft ? config?.providers[roleDraft.provider]?.models.map((model) => model.id) ?? [] : []
  const updateProvider = (key: keyof Provider, value: string) => {
    setProviderDraft((draft) => {
      if (!draft) return draft
      if (key === 'apiKeyEnv') return { ...draft, apiKeyEnv: lines(value) }
      if (key === 'models') {
        const old = new Map(draft.models.map((model) => [model.id, model]))
        return { ...draft, models: lines(value).map((id) => old.get(id) ?? { id }) }
      }
      if (key === 'protocol') return { ...draft, protocol: value as Provider['protocol'] }
      if (key === 'baseUrl') return { ...draft, baseUrl: value }
      return draft
    })
  }

  const save = async (kind: 'providers' | 'roles', id: string, value: Provider | Role) => {
    setBusy(true)
    setErrors([])
    setMessage('')
    try {
      await api(`/api/config/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      await load()
      setMessage(t('configSaved'))
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors.length ? e.errors : [e.code] : [(e as Error).message])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid max-w-5xl gap-5" data-testid="operator-config">
      <h2 className="text-lg font-semibold">{t('configTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('configIntro')}</p>
      {!session ? <Alert><AlertDescription>{t('designerNoSession')}</AlertDescription></Alert> : null}
      {errors.length ? <Alert variant="destructive"><AlertDescription><ul className="list-disc pl-5">{errors.map((error, i) => <li key={`${i}-${error}`}>{error}</li>)}</ul></AlertDescription></Alert> : null}
      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {!config || !providerDraft ? <Card><CardContent className="p-5 text-sm text-muted-foreground">{errors.length ? t('configInvalidJson') : '…'}</CardContent></Card> : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>{t('configProviders')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">{t('configProviderId')}
                <Input aria-label={t('configProviderId')} value={providerId} onChange={(e) => setProviderId(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                {Object.keys(config.providers).map((id) => <Button key={id} variant={providerId === id ? 'default' : 'outline'} size="sm" onClick={() => setProviderId(id)}>{id}</Button>)}
                <Button variant="outline" size="sm" onClick={() => setProviderId('new-provider')}>{t('configNewProvider')}</Button>
              </div>
              <label className="grid gap-1.5 text-sm font-medium">{t('configProtocol')}
                <select aria-label={t('configProtocol')} className="h-9 rounded-md border bg-background px-3 text-sm" value={providerDraft.protocol} onChange={(e) => updateProvider('protocol', e.target.value)}>
                  <option value="openai-compatible">openai-compatible</option><option value="anthropic">anthropic</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">{t('configBaseUrl')}<Input aria-label={t('configBaseUrl')} value={providerDraft.baseUrl} onChange={(e) => updateProvider('baseUrl', e.target.value)} /></label>
              <label className="grid gap-1.5 text-sm font-medium">{t('configKeyEnv')}<textarea aria-label={t('configKeyEnv')} className="min-h-20 rounded-md border bg-background p-2 font-mono text-xs" value={joinLines(providerDraft.apiKeyEnv)} onChange={(e) => updateProvider('apiKeyEnv', e.target.value)} /></label>
              <label className="grid gap-1.5 text-sm font-medium">{t('configModels')}<textarea aria-label={t('configModels')} className="min-h-24 rounded-md border bg-background p-2 font-mono text-xs" value={joinLines(providerDraft.models.map((model) => model.id))} onChange={(e) => updateProvider('models', e.target.value)} /></label>
              <Button disabled={!session || busy} onClick={() => void save('providers', providerId, providerDraft)}>{busy ? t('configSaving') : t('configSave')}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t('configRoles')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">{t('configRole')}
                <select aria-label={t('configRole')} className="h-9 rounded-md border bg-background px-3 text-sm" value={roleId} onChange={(e) => setRoleId(e.target.value as typeof roleId)}>
                  {SYSTEM_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </label>
              {roleDraft ? <>
                <label className="grid gap-1.5 text-sm font-medium">{t('configProviders')}
                  <select aria-label={`${t('configProviders')} ${t('configRole')}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={roleDraft.provider} onChange={(e) => {
                    const provider = e.target.value
                    const firstModel = config.providers[provider]?.models[0]?.id ?? ''
                    setRoleDraft((draft) => draft ? { ...draft, provider, model: firstModel, fallbacks: [] } : draft)
                  }}>
                    {roleProviders.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">{t('configModel')}
                  <select aria-label={t('configModel')} className="h-9 rounded-md border bg-background px-3 text-sm" value={roleDraft.model} onChange={(e) => setRoleDraft({ ...roleDraft, model: e.target.value })}>
                    {roleModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">{t('configTemperature')}<Input aria-label={t('configTemperature')} type="number" min="0" max="2" step="0.1" value={roleDraft.temperature} onChange={(e) => setRoleDraft({ ...roleDraft, temperature: Number(e.target.value) })} /></label>
                <label className="grid gap-1.5 text-sm font-medium">{t('configFallbacks')}<textarea aria-label={t('configFallbacks')} className="min-h-20 rounded-md border bg-background p-2 font-mono text-xs" value={joinLines(roleDraft.fallbacks)} onChange={(e) => setRoleDraft({ ...roleDraft, fallbacks: lines(e.target.value) })} /></label>
                <Button disabled={!session || busy || roleProviders.length === 0} onClick={() => void save('roles', roleId, roleDraft)}>{busy ? t('configSaving') : t('configSave')}</Button>
              </> : <p className="text-sm text-muted-foreground">{t('configSelectProvider')}</p>}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
