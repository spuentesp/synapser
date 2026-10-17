import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

type McpServer = {
  id: string
  enabled: boolean
  artifactPinned: boolean
  version: string
  expectedServer: { name: string; version: string }
  profiles: Record<string, string[]>
}
type McpRegistration = {
  id: string
  enabled: boolean
  origin: string
  version: string
  command: string
  args: string[]
  artifact?: { digest: string; entrypoint: string }
  expectedServer: { name: string; version: string }
  profiles: Record<string, string[]>
}
type McpTool = { name: string; description?: string; inputSchema: unknown }
type Discovery = { serverInfo: { name: string; version: string }; tools: McpTool[] }

const emptyRegistration = (): McpRegistration => ({
  id: '', enabled: false, origin: '', version: '', command: '', args: [], artifact: undefined,
  expectedServer: { name: '', version: '' }, profiles: {},
})

const toProfileText = (profiles: Record<string, string[]>) => Object.entries(profiles).map(([profile, tools]) => `${profile}: ${tools.join(', ')}`).join('\n')

function fromProfileText(value: string): Record<string, string[]> {
  const profiles: Record<string, string[]> = {}
  for (const line of value.split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error('Each profile line must use profile-id: tool-a, tool-b')
    const profile = line.slice(0, separator).trim()
    const tools = line.slice(separator + 1).split(',').map((tool) => tool.trim()).filter(Boolean)
    if (!profile || Object.hasOwn(profiles, profile)) throw new Error('Profile IDs must be non-empty and unique')
    profiles[profile] = tools
  }
  return profiles
}

export function McpCuration({ session }: { session: boolean }) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServer[]>([])
  const [loaded, setLoaded] = useState(false)
  const [profileIds, setProfileIds] = useState<Record<string, string>>({})
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState<string | null>(null)
  const [testArguments, setTestArguments] = useState<Record<string, string>>({})
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState('')
  const [registrations, setRegistrations] = useState<McpRegistration[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState<McpRegistration>(emptyRegistration)
  const [profileText, setProfileText] = useState('')
  const [argsText, setArgsText] = useState('[]')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const selectRegistration = useCallback((registration: McpRegistration) => {
    setForm(registration)
    setSelectedId(registration.id)
    setProfileText(toProfileText(registration.profiles))
    setArgsText(JSON.stringify(registration.args, null, 2))
    setSaved(false)
  }, [])

  useEffect(() => {
    void api<{ servers: McpServer[] }>('/api/mcp').then(({ servers: rows }) => {
      setServers(rows)
      setProfileIds(Object.fromEntries(rows.map((server) => [server.id, Object.keys(server.profiles)[0] ?? ''])))
    }).catch((error: unknown) => setFailure(error instanceof ApiError ? error.code : (error as Error).message)).finally(() => setLoaded(true))
    if (session) void api<{ servers: McpRegistration[] }>('/api/config/mcpServers').then(({ servers: rows }) => {
      setRegistrations(rows)
      if (rows[0]) selectRegistration(rows[0])
    }).catch((error: unknown) => setFailure(error instanceof ApiError ? error.code : (error as Error).message))
  }, [session, selectRegistration])

  const startNew = () => {
    setForm(emptyRegistration())
    setSelectedId('')
    setProfileText('')
    setArgsText('[]')
    setSaved(false)
  }

  const saveRegistration = async () => {
    setSaving(true)
    setFailure('')
    setSaved(false)
    try {
      const profiles = fromProfileText(profileText)
      const parsedArgs: unknown = JSON.parse(argsText)
      if (!Array.isArray(parsedArgs) || parsedArgs.some((arg) => typeof arg !== 'string')) throw new Error('Arguments must be a JSON array of strings')
      const next: McpRegistration = {
        ...form,
        args: parsedArgs,
        profiles,
        ...(form.artifact?.digest && form.artifact.entrypoint ? { artifact: form.artifact } : { artifact: undefined }),
      }
      await api(`/api/config/mcpServers/${encodeURIComponent(form.id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
      })
      const latest = await api<{ servers: McpRegistration[] }>('/api/config/mcpServers')
      setRegistrations(latest.servers)
      selectRegistration(latest.servers.find((registration) => registration.id === form.id) ?? next)
      const publicList = await api<{ servers: McpServer[] }>('/api/mcp')
      setServers(publicList.servers)
      setSaved(true)
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const discover = async (server: McpServer) => {
    const profileId = profileIds[server.id] ?? ''
    if (!profileId) return
    setBusy(server.id)
    setFailure('')
    try {
      const result = await api<Discovery>(`/api/mcp/${encodeURIComponent(server.id)}/discover`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId }),
      })
      setDiscoveries((current) => ({ ...current, [server.id]: result }))
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : (error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const testCall = async (server: McpServer, tool: McpTool) => {
    const profileId = profileIds[server.id] ?? ''
    const key = `${server.id}:${tool.name}`
    if (!profileId || !window.confirm(t('mcpTestConfirm'))) return
    setTestBusy(key)
    setFailure('')
    setTestResults((current) => ({ ...current, [key]: '' }))
    try {
      const parsed: unknown = JSON.parse(testArguments[key] ?? '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('mcpTestArgumentsInvalid'))
      const result = await api<{ toolName: string; result: unknown }>(`/api/mcp/${encodeURIComponent(server.id)}/test-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId, toolName: tool.name, arguments: parsed }),
      })
      setTestResults((current) => ({ ...current, [key]: JSON.stringify(result.result, null, 2) }))
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : (error as Error).message)
    } finally {
      setTestBusy(null)
    }
  }

  return (
    <Card data-testid="mcp-curation">
      <CardHeader><CardTitle>{t('mcpTitle')}</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('mcpDiscoveryOnly')}</p>
        {session ? <section className="grid gap-3 rounded-md border p-4" data-testid="mcp-registration-editor">
          <div className="flex flex-wrap items-center gap-2">
            <label className="grid gap-1 text-sm">{t('mcpEditRegistration')}
              <select aria-label={t('mcpEditRegistration')} className="h-9 rounded-md border bg-background px-3" value={selectedId} onChange={(event) => {
                const registration = registrations.find((item) => item.id === event.target.value)
                if (registration) selectRegistration(registration)
                else startNew()
              }}>
                <option value="">{t('mcpNewRegistration')}</option>
                {registrations.map((registration) => <option key={registration.id} value={registration.id}>{registration.id}</option>)}
              </select>
            </label>
            <Button type="button" variant="outline" size="sm" onClick={startNew}>{t('mcpNewRegistration')}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('mcpRegistrationWarning')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm">ID<input className="h-9 rounded-md border bg-background px-3" disabled={selectedId !== ''} value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpOriginDeclared')}<input className="h-9 rounded-md border bg-background px-3" value={form.origin} onChange={(event) => setForm({ ...form, origin: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpVersionDeclared')}<input className="h-9 rounded-md border bg-background px-3" value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpRuntime')}<input className="h-9 rounded-md border bg-background px-3" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpArtifactDigest')}<input className="h-9 rounded-md border bg-background px-3" value={form.artifact?.digest ?? ''} onChange={(event) => setForm({ ...form, artifact: { digest: event.target.value, entrypoint: form.artifact?.entrypoint ?? '' } })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpArtifactEntrypoint')}<input className="h-9 rounded-md border bg-background px-3" value={form.artifact?.entrypoint ?? ''} onChange={(event) => setForm({ ...form, artifact: { digest: form.artifact?.digest ?? '', entrypoint: event.target.value } })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpExpectedName')}<input className="h-9 rounded-md border bg-background px-3" value={form.expectedServer.name} onChange={(event) => setForm({ ...form, expectedServer: { ...form.expectedServer, name: event.target.value } })} /></label>
            <label className="grid gap-1 text-sm">{t('mcpExpectedVersion')}<input className="h-9 rounded-md border bg-background px-3" value={form.expectedServer.version} onChange={(event) => setForm({ ...form, expectedServer: { ...form.expectedServer, version: event.target.value } })} /></label>
          </div>
          <label className="grid gap-1 text-sm">{t('mcpArgs')}<textarea className="min-h-20 rounded-md border bg-background p-2 font-mono text-xs" value={argsText} onChange={(event) => setArgsText(event.target.value)} /></label>
          <label className="grid gap-1 text-sm">{t('mcpProfileAllowlists')}<textarea className="min-h-20 rounded-md border bg-background p-2 font-mono text-xs" value={profileText} onChange={(event) => setProfileText(event.target.value)} placeholder="profile-id: tool-a, tool-b" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />{t('mcpEnabled')}</label>
          <div className="flex items-center gap-3"><Button disabled={saving || !form.id} onClick={() => void saveRegistration()}>{saving ? t('mcpSaving') : t('mcpSaveRegistration')}</Button>{saved ? <span role="status" className="text-sm text-muted-foreground">{t('mcpRegistrationSaved')}</span> : null}</div>
        </section> : null}
        {failure ? <Alert variant="destructive"><AlertDescription role="alert">{failure}</AlertDescription></Alert> : null}
        {!loaded ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : servers.length === 0 ? <p className="text-sm text-muted-foreground">{t('mcpEmpty')}</p> : null}
        {servers.map((server) => {
          const profiles = Object.keys(server.profiles)
          const discovery = discoveries[server.id]
          return (
            <section key={server.id} className="grid gap-3 rounded-md border p-4" data-testid={`mcp-server-${server.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium">{server.id}</h3>
                  <p className="text-xs text-muted-foreground">{server.enabled ? t('mcpEnabled') : t('mcpDisabled')} · {server.artifactPinned ? t('mcpArtifactPinned') : t('mcpArtifactUnpinned')} · {t('mcpExpectedIdentity')}: {server.expectedServer.name} {server.expectedServer.version} · {t('mcpConfiguredVersion')}: {server.version}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {profiles.length > 0 ? <select
                    aria-label={`${t('mcpProfile')} ${server.id}`}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={profileIds[server.id] ?? ''}
                    onChange={(event) => setProfileIds((current) => ({ ...current, [server.id]: event.target.value }))}
                  >{profiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}</select> : <span className="text-sm text-muted-foreground">{t('mcpNoProfiles')}</span>}
                  <Button size="sm" variant="outline" disabled={!session || !server.enabled || !server.artifactPinned || profiles.length === 0 || busy !== null} onClick={() => void discover(server)}>
                    {busy === server.id ? t('mcpDiscovering') : t('mcpDiscover')}
                  </Button>
                </div>
              </div>
              {discovery ? <div className="grid gap-2 border-t pt-3" data-testid={`mcp-discovery-${server.id}`}>
                <p className="text-sm">{t('mcpObservedIdentity')}: {discovery.serverInfo.name} {discovery.serverInfo.version}</p>
                {discovery.tools.length === 0 ? <p className="text-sm text-muted-foreground">{t('mcpNoTools')}</p> : discovery.tools.map((tool) => <details key={tool.name} className="rounded border p-3">
                  <summary className="cursor-pointer text-sm font-medium">{tool.name}</summary>
                  {tool.description ? <p className="mt-2 text-sm text-muted-foreground">{tool.description}</p> : null}
                  <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  {session ? <div className="mt-3 grid gap-2">
                    <label className="grid gap-1 text-sm">{t('mcpTestArguments')} · {tool.name}
                      <textarea aria-label={`${t('mcpTestArguments')} ${tool.name}`} className="min-h-16 rounded-md border bg-background p-2 font-mono text-xs" value={testArguments[`${server.id}:${tool.name}`] ?? '{}'} onChange={(event) => setTestArguments((current) => ({ ...current, [`${server.id}:${tool.name}`]: event.target.value }))} />
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" size="sm" variant="outline" disabled={!server.enabled || !server.artifactPinned || busy !== null || testBusy !== null} onClick={() => void testCall(server, tool)}>
                        {testBusy === `${server.id}:${tool.name}` ? t('mcpTestRunning') : t('mcpTestCall')}
                      </Button>
                      {testResults[`${server.id}:${tool.name}`] ? <pre role="status" className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{testResults[`${server.id}:${tool.name}`]}</pre> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{t('mcpTestWarning')}</p>
                  </div> : null}
                </details>)}
              </div> : null}
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}
