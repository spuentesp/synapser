import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { STATUS_LABEL, useI18n } from '@/lib/i18n'
import type { AgentStatus } from '@/lib/api'

const TONE: Record<AgentStatus, string> = {
  planned: 'bg-muted text-muted-foreground',
  ready: 'bg-muted text-foreground',
  running: 'bg-status-running/15 text-status-running',
  waiting: 'bg-status-waiting/15 text-status-waiting',
  waiting_approval: 'bg-status-approval/15 text-status-approval',
  validating: 'bg-status-validating/15 text-status-validating',
  done: 'bg-status-done/15 text-status-done',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-destructive/10 text-destructive/80',
}
export const BORDER: Record<AgentStatus, string> = {
  planned: 'border-l-border', ready: 'border-l-border', running: 'border-l-status-running', waiting: 'border-l-status-waiting',
  waiting_approval: 'border-l-status-approval', validating: 'border-l-status-validating', done: 'border-l-status-done',
  failed: 'border-l-destructive', cancelled: 'border-l-destructive',
}

export function StatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  const { lang } = useI18n()
  return (
    <Badge variant="secondary" className={cn('uppercase', TONE[status], className)}>
      {STATUS_LABEL[lang][status] ?? status}
    </Badge>
  )
}
