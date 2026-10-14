import { useEffect, useMemo, useState } from 'react'
import { Activity, Bot, Coins, MessageSquare, Workflow, GitBranch, History, Languages, LayoutDashboard, Layers, Moon, ShieldCheck, Sun, Users, CheckCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { EvidenceProvider } from '@/components/evidence'
import { AgentsView } from '@/components/views/agents-view'
import { ChatView } from '@/components/views/chat-view'
import { WorkflowsView } from '@/components/views/workflows-view'
import { LibraryView } from '@/components/views/library-view'
import { HomeView } from '@/components/views/home-view'
import { SessionGate } from '@/components/views/session-gate'
import { ApprovalsView } from '@/components/views/approvals-view'
import { Empty, ErrorNote, Loading } from '@/components/views/common'
import { CoordinationView } from '@/components/views/coordination-view'
import { CostView } from '@/components/views/cost-view'
import { IntegrityView } from '@/components/views/integrity-view'
import { SwarmView } from '@/components/views/swarm-view'
import { TimelineView } from '@/components/views/timeline-view'
import { WhyView } from '@/components/views/why-view'
import { useLedger } from '@/hooks/useLedger'
import { shortHash } from '@/lib/format'
import { I18nContext, makeT, type Key, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const VIEWS = ['home', 'chat', 'workflows', 'agents', 'library', 'swarm', 'timeline', 'why', 'cost', 'coordination', 'approvals', 'integrity'] as const
type View = (typeof VIEWS)[number]
const ICON: Record<View, typeof Users> = {
  home: LayoutDashboard, chat: MessageSquare, workflows: Workflow, agents: Bot, library: Layers, swarm: Users, timeline: History, why: GitBranch, cost: Coins, coordination: Activity, approvals: CheckCheck, integrity: ShieldCheck,
}

const readHash = (): View => {
  const h = decodeURIComponent(location.hash.slice(1)).split('?')[0] as View
  return VIEWS.includes(h) ? h : 'home'
}

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const q = new URLSearchParams(location.search).get('lang')
    const s = q ?? localStorage.getItem('lang') ?? navigator.language.slice(0, 2)
    return s === 'en' ? 'en' : 'es'
  })
  const [dark, setDark] = useState(() => {
    const q = new URLSearchParams(location.search).get('theme')
    if (q === 'dark' || q === 'light') return q === 'dark'
    const s = localStorage.getItem('theme')
    return s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [view, setView] = useState<View>(readHash)
  const [wfId, setWfId] = useState<string | null>(null)
  const L = useLedger()
  const t = useMemo(() => makeT(lang), [lang])
  const i18n = useMemo(() => ({ lang, t, setLang: (l: Lang) => (localStorage.setItem('lang', l), setLang(l)) }), [lang, t])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.lang = lang
  }, [dark, lang])
  useEffect(() => {
    const on = () => setView(readHash())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  const go = (v: View) => {
    history.replaceState(null, '', `#${v}`)
    setView(v)
  }
  // the run of a selected workflow is the default context of the run views (plan 14 Q4.3)
  const openWorkflow = (id: string | null) => {
    setWfId(id)
    if (id) L.setRunId(id)
  }
  const pending = L.state?.pendingApprovals.length ?? 0
  const run = L.run
  const labels: Record<View, Key> = { home: 'home', chat: 'chat', workflows: 'workflows', agents: 'agents', library: 'library', swarm: 'swarm', timeline: 'timeline', why: 'why', cost: 'cost', coordination: 'coordination', approvals: 'approvals', integrity: 'integrity' }

  const GLOBAL: View[] = ['home', 'chat', 'workflows', 'agents', 'library']
  // adversarial mode: nothing works until the one-time code is redeemed (plan 15 D7)
  const gated = !L.session && L.needsCode
  let body: React.ReactNode
  if (GLOBAL.includes(view)) {
    body = {
      chat: <ChatView session={L.session} onOpen={(id) => { openWorkflow(id); go('workflows') }} />,
      workflows: <WorkflowsView session={L.session} tick={L.tick} selected={wfId} onSelect={openWorkflow} />,
      agents: <AgentsView />,
      library: <LibraryView session={L.session} />,
      home: <HomeView onNavigate={(v) => go(v)} onOpenRun={(id) => { if (id) L.setRunId(id); go('approvals') }} />,
    }[view as 'home' | 'chat' | 'workflows' | 'agents' | 'library']
  } else if (L.error && !run) body = <ErrorNote code={L.error} />
  else if (!run || !L.state || !L.runId) body = !L.loaded ? <Loading /> : <Empty><span className="block">{t('noRunsHint')}</span><Button size="sm" variant="outline" className="mt-2" onClick={() => go('workflows')}>{t('homeCreate')}</Button></Empty>
  else {
    const id = L.runId
    body = {
      swarm: <SwarmView state={L.state} runId={id} />,
      timeline: <TimelineView runId={id} tick={L.tick} upTo={L.seq} />,
      why: <WhyView runId={id} tick={L.tick} />,
      cost: <CostView runId={id} tick={L.tick} />,
      coordination: <CoordinationView runId={id} tick={L.tick} />,
      approvals: <ApprovalsView runId={id} state={L.state} session={L.session} onDecided={L.refresh} />,
      integrity: <IntegrityView runId={id} tick={L.tick} onVerify={L.refresh} />,
    }[view as 'swarm']
  }

  return (
    <I18nContext.Provider value={i18n}>
      <EvidenceProvider>
        <div className="grid min-h-screen grid-cols-1 bg-background text-foreground md:grid-cols-[240px_1fr]">
          <aside className="flex flex-col gap-4 border-b bg-card p-4 md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
            <div className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
              <span className="size-6 rounded-md bg-linear-to-br from-status-running via-status-validating to-status-done" />
              Synapser
            </div>
            <div className="grid gap-1.5 text-xs text-muted-foreground">
              {t('run')}
              <Select value={L.runId ?? ''} onValueChange={(v) => v && L.setRunId(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent><SelectGroup>{L.runs.map((r) => <SelectItem key={r.id} value={r.id}>{r.id}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </div>
            {run ? (
              <div
                data-testid="integrity"
                data-ok={run.chainOk}
                className={cn('grid gap-0.5 rounded-xl border p-3 text-xs', run.chainOk ? 'border-status-done/40 bg-status-done/5' : 'border-destructive/60 bg-destructive/10')}
              >
                <div className={cn('flex items-center gap-1.5 text-[13px] font-bold', run.chainOk ? 'text-status-done' : 'text-destructive')}>
                  <ShieldCheck className="size-4" />
                  {run.chainOk ? t('verified') : t('broken')}
                </div>
                <span className="text-muted-foreground">{run.events} {t('events')}</span>
                <code className="font-mono text-muted-foreground">{t('head')} {shortHash(run.head, 14)}</code>
              </div>
            ) : null}
            <nav className="grid gap-0.5" aria-label="views">
              {VIEWS.map((v) => {
                const Icon = ICON[v]
                return (
                  <button
                    key={v}
                    type="button"
                    data-view={v}
                    aria-current={view === v ? 'page' : undefined}
                    onClick={() => go(v)}
                    className={cn(
                      'flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                      view === v && 'bg-primary/10 font-semibold text-foreground',
                    )}
                  >
                    <span className="flex items-center gap-2"><Icon className="size-4" />{t(labels[v])}</span>
                    {v === 'approvals' && pending ? <Badge className="bg-status-waiting text-background">{pending}</Badge> : null}
                  </button>
                )
              })}
            </nav>
            <div className="mt-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => i18n.setLang(lang === 'es' ? 'en' : 'es')}><Languages data-icon="inline-start" />{lang.toUpperCase()}</Button>
              <Button variant="outline" size="sm" aria-label="theme" onClick={() => (localStorage.setItem('theme', dark ? 'light' : 'dark'), setDark(!dark))}>
                {dark ? <Moon /> : <Sun />}
              </Button>
            </div>
          </aside>

          <main className="min-w-0 p-5 pb-16 md:px-7">
            <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
              <div className="text-[15px] font-semibold" data-testid="mission-line">
                {L.state?.mission.state ?? '—'}{' '}
                {L.state ? <span className="font-normal text-muted-foreground">· {t('plan')} r{L.state.mission.planRevision} · {L.state.agents.length} {t('tasks')}</span> : null}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="live"
                  onClick={() => L.setSeq(null)}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', L.live ? 'border-status-done/50 text-status-done' : 'text-muted-foreground')}
                >
                  {L.live ? <span className="size-1.5 animate-pulse rounded-full bg-status-done" /> : null}
                  {L.live ? t('live') : `${t('replay')} · ${L.seq}`}
                </button>
                <div className="w-56">
                <Slider
                  min={1}
                  max={Math.max(1, L.head)}
                  value={[L.seq ?? L.head]}
                  onValueChange={(v) => {
                    const n = Array.isArray(v) ? (v[0] ?? L.head) : v
                    L.setSeq(n >= L.head ? null : n)
                  }}
                  aria-label={t('replay')}
                />
                </div>
                <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{t('seq')} {L.seq ?? L.head}</span>
              </div>
            </header>
            <h1 className="mb-4 text-xl font-bold">{t(labels[view])}</h1>
            {gated ? <SessionGate onGranted={L.refreshSession} /> : body}
          </main>
        </div>
      </EvidenceProvider>
    </I18nContext.Provider>
  )
}
