import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ErrorNote } from './common'

interface Msg { role: 'user' | 'assistant'; content: string; drafts?: string[]; tools?: string[] }

export function ChatView({ session, onOpen }: { session: boolean; onOpen: (workflowId: string) => void }) {
  const { t } = useI18n()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [conv, setConv] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (end.current) end.current.scrollIntoView({ block: 'end' })
  }, [msgs, busy])

  const submit = async () => {
    const q = text.trim()
    if (!q || busy || !session) return
    setText('')
    setErr(null)
    setBusy(true)
    setMsgs((m) => [...m, { role: 'user', content: q }])
    try {
      const r = await api<{ conversationId: string; reply: string; drafts: string[]; trace: { tool: string }[] }>('/api/chat/send', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: conv, text: q }),
      })
      setConv(r.conversationId)
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, drafts: r.drafts, tools: r.trace.map((x) => x.tool) }])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <p className="text-sm text-muted-foreground">{t('chatNote')}</p>
      <div className="grid gap-3" data-testid="chat-log">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'justify-self-end max-w-[85%] rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground' : 'max-w-[85%] rounded-2xl border bg-card px-3.5 py-2 text-sm'}>
            <div className="whitespace-pre-wrap">{m.content}</div>
            {m.tools?.length ? <div className="mt-1.5 flex flex-wrap gap-1">{m.tools.map((x, k) => <Badge key={k} variant="outline" className="font-mono text-[10px]">{x}</Badge>)}</div> : null}
            {m.drafts?.map((d) => (
              <div key={d} className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/50 p-2 text-xs">
                <span className="font-semibold">{t('draftReady')}</span><code className="font-mono">{d}</code>
                <Button size="xs" variant="outline" onClick={() => onOpen(d)}>{t('openWorkflow')}</Button>
              </div>
            ))}
          </div>
        ))}
        {busy ? <p className="text-sm text-muted-foreground">{t('thinking')}</p> : null}
        <div ref={end} />
      </div>
      {err ? <ErrorNote code={err} /> : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={text} placeholder={t('chatHint')} rows={2} data-testid="chat-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
        />
        <Button onClick={() => void submit()} disabled={busy || !text.trim() || !session}><Send data-icon="inline-start" />{t('send')}</Button>
      </div>
    </div>
  )
}
