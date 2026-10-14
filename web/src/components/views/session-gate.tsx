// The one-time code of adversarial mode (plan 15 D7). serve prints it in the terminal; the page redeems it once for the
// session cookie, and the cookie is what every later request carries.
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api, ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

export function SessionGate({ onGranted }: { onGranted: () => void }) {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await api('/api/session/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) })
      onGranted()
    } catch (e) {
      setFailure(e instanceof ApiError ? e.code : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>{t('sessionCodeTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('sessionCodeHint')}</p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="session-code">{t('sessionCodeLabel')}</FieldLabel>
            <Input id="session-code" className="font-mono" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </FieldGroup>
        {failure ? (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
        <Button disabled={busy || code.trim() === ''} onClick={() => void submit()}>{t('sessionCodeButton')}</Button>
      </CardContent>
    </Card>
  )
}
