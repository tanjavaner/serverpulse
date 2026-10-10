import { useState, type ReactNode } from 'react'
import type { ImportInspect } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { dateTime } from '../lib/format'
import { Alert, Button, Card, Field, SectionTitle, Toggle } from '../components/ui'

const MIN_PASSWORD = 8

/** Ayarlar → yapılandırmayı dosyaya aktar / dosyadan al (yeni bilgisayara taşıma). */
export function TransferCard(): ReactNode {
  const [withSecrets, setWithSecrets] = useState(false)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<ImportInspect | null>(null)
  const [importPassword, setImportPassword] = useState('')
  const [importSettings, setImportSettings] = useState(true)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const doExport = (): Promise<void> =>
    run(async () => {
      const r = await api.invoke('config:export', { includeSecrets: withSecrets, password: withSecrets ? password : undefined })
      if (r.cancelled) return
      setMsg(r.ok ? { kind: 'ok', text: t('xfer.exported', { p: r.path }) } : { kind: 'error', text: r.error ?? '' })
      if (r.ok) setPassword('')
    })

  const pick = (): Promise<void> =>
    run(async () => {
      const r = await api.invoke('config:inspectImport')
      if (r.cancelled) return
      if (!r.ok) return setMsg({ kind: 'error', text: r.error ?? '' })
      setPending(r)
      setImportPassword('')
    })

  const doImport = (): Promise<void> =>
    run(async () => {
      if (!pending?.path) return
      const r = await api.invoke('config:import', pending.path, { password: importPassword || undefined, settings: importSettings })
      if (r.needsPassword && !r.error) return setMsg({ kind: 'warn', text: t('xfer.encrypted') })
      if (r.error) return setMsg({ kind: 'error', text: r.error })
      const text = [t('xfer.imported', { n: r.added, s: r.skipped }), ...r.errors, r.added && !pending.encrypted ? t('xfer.noSecretsNote') : ''].filter(Boolean).join(' ')
      setMsg({ kind: r.ok ? 'ok' : 'warn', text })
      setPending(null)
    })

  const exportBlocked = withSecrets && password.length < MIN_PASSWORD

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>{t('xfer.title')}</SectionTitle>
      <div className="text-[12px] text-ink-2">{t('xfer.intro')}</div>

      <Toggle checked={withSecrets} onChange={setWithSecrets} label={t('xfer.includeSecrets')} hint={t('xfer.includeSecretsHint')} />
      {withSecrets ? (
        <Field label={t('xfer.password', { n: MIN_PASSWORD })}>
          <input type="password" className="max-w-xs" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || exportBlocked} onClick={() => void doExport()}>
          {t('xfer.export')}
        </Button>
        <Button disabled={busy} onClick={() => void pick()}>
          {t('xfer.import')}
        </Button>
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <div className="font-mono text-[11px] break-all text-ink-2">{pending.path}</div>
          <div className="text-[12px]">
            {t('xfer.summary', { s: pending.servers, p: pending.projects, d: pending.exportedAt ? dateTime(Date.parse(pending.exportedAt)) : '—' })}
          </div>
          {pending.encrypted ? (
            <Field label={t('xfer.encrypted')}>
              <input type="password" className="max-w-xs" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} autoComplete="off" />
            </Field>
          ) : null}
          <Toggle checked={importSettings} onChange={setImportSettings} label={t('xfer.importSettings')} />
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || (pending.encrypted && !importPassword)} onClick={() => void doImport()}>
              {t('xfer.doImport')}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
    </Card>
  )
}
