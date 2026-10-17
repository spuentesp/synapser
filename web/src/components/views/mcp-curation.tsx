import { useEffect, useState } from 'react'
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
type McpTool = { name: string; description?: string; inputSchema: unknown }
type Discovery = { serverInfo: { name: string; version: string }; tools: McpTool[] }

export function McpCuration({ session }: { session: boolean }) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServer[]>([])
  const [loaded, setLoaded] = useState(false)
  const [profileIds, setProfileIds] = useState<Record<string, string>>({})
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    void api<{ servers: McpServer[] }>('/api/mcp').then(({ servers: rows }) => {
      setServers(rows)
      setProfileIds(Object.fromEntries(rows.map((server) => [server.id, Object.keys(server.profiles)[0] ?? ''])))
    }).catch((error: unknown) => setFailure(error instanceof ApiError ? error.code : (error as Error).message)).finally(() => setLoaded(true))
  }, [])

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

  return (
    <Card data-testid="mcp-curation">
      <CardHeader><CardTitle>{t('mcpTitle')}</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('mcpDiscoveryOnly')}</p>
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
                </details>)}
              </div> : null}
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}
