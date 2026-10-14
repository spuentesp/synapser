import { createContext, useContext, useState, type ReactNode } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { runPath, type Evidence, type TimelineEntry } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

interface Ctx {
  open: (runId: string, seqs: number[]) => void
}
const EvidenceCtx = createContext<Ctx>({ open: () => {} })

/** The citation drawer (U2): every figure can show the ledger events it was computed from. */
export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<{ runId: string; seqs: number[] } | null>(null)
  const { t, lang } = useI18n()
  const { data, loading } = useQuery<{ entries: TimelineEntry[] }>(target ? runPath(target.runId, '/timeline') : null)
  const rows = target && data ? data.entries.filter((e) => target.seqs.includes(e.seq)) : []
  return (
    <EvidenceCtx.Provider value={{ open: (runId, seqs) => setTarget({ runId, seqs }) }}>
      {children}
      <Sheet open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <SheetContent className="w-[min(520px,94vw)] gap-0 sm:max-w-[520px]">
          <SheetHeader>
            <SheetTitle>{t('evidence')}</SheetTitle>
            <SheetDescription>{target ? `${target.seqs.length} ${t('events')}` : ''}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 overflow-auto px-4 pb-4">
            {loading && !rows.length ? <Skeleton className="h-16 w-full" /> : null}
            {rows.map((e) => (
              <div key={e.seq} className="rounded-lg border p-3 text-sm">
                <div className="mb-1 font-mono text-xs text-muted-foreground">
                  #{e.seq} · {fmtTime(e.ts, lang)} · {e.kind}
                </div>
                {e.summary}
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </EvidenceCtx.Provider>
  )
}

export function Cite({ runId, evidence }: { runId: string; evidence: Evidence | undefined }) {
  const { open } = useContext(EvidenceCtx)
  const { t } = useI18n()
  if (!evidence?.total) return null
  return (
    <button
      type="button"
      data-cite
      onClick={() => open(runId, evidence.seqs)}
      className="self-start text-xs text-primary underline decoration-dotted underline-offset-4 hover:decoration-solid"
    >
      {t('evidence')} · {evidence.total}
    </button>
  )
}
