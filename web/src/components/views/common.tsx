import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Empty as EmptyBox, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/lib/i18n'

export function ErrorNote({ code }: { code: string }) {
  const { t } = useI18n()
  return (
    <Alert variant="destructive">
      <AlertTitle>{t('error')}</AlertTitle>
      <AlertDescription>{code}</AlertDescription>
    </Alert>
  )
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <EmptyBox className="border border-dashed">
      <EmptyHeader>
        <EmptyTitle>{children ?? t('empty')}</EmptyTitle>
        <EmptyDescription />
      </EmptyHeader>
    </EmptyBox>
  )
}

export function Loading() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <code className={`font-mono text-xs ${className}`}>{children}</code>
}
