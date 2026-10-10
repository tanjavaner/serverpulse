import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { buildSetupScript, normalizePubKey, SETUP_USER_RE } from '@shared/setup'
import { api } from '../lib/api'
import { Alert, Button, Toggle } from '../components/ui'

/**
 * Sunucu formundaki "Sunucuyu hazırla" bölümü: izleme kullanıcısını oluşturan betiği canlı üretir.
 * Betik sunucuda kullanıcı tarafından çalıştırılır; uygulama hiçbir şeyi kendisi değiştirmez.
 */
export function SetupCard({
  user,
  asterisk,
  keySource
}: {
  user: string
  asterisk: boolean
  /** Public satırı çıkarılabilecek özel anahtar (yeni seçilen dosya ya da kayıtlı sunucu anahtarı). */
  keySource: { privateKeyPath?: string; serverId?: string; passphrase?: string } | null
}): ReactNode {
  const [opts, setOpts] = useState({ docker: true, journal: true, maint: false, asterisk })
  // Asterisk seçeneği yalnızca formda Asterisk açıkken görünür; kapatılınca betikte gizli kural kalmasın
  useEffect(() => setOpts((o) => ({ ...o, asterisk })), [asterisk])
  const [pubKey, setPubKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const userOk = SETUP_USER_RE.test(user) && user !== 'root'
  const keyOk = !pubKey.trim() || normalizePubKey(pubKey) !== null
  const script = useMemo(() => (userOk && keyOk ? buildSetupScript({ user, pubKey, ...opts }) : ''), [user, pubKey, opts, userOk, keyOk])

  const fromKey = async (): Promise<void> => {
    if (!keySource) return
    setKeyError(null)
    const r = await api.invoke('server:publicKey', keySource)
    if (r.ok && r.key) setPubKey(r.key)
    else setKeyError(r.error ?? t('setup.badKey'))
  }

  const copy = async (): Promise<void> => {
    await api.invoke('app:copy', script)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const set = (k: keyof typeof opts) => (v: boolean) => setOpts((o) => ({ ...o, [k]: v }))

  return (
    <details className="rounded-xl border border-line bg-surface p-4">
      <summary className="cursor-pointer text-sm font-semibold">{t('setup.title')}</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div className="text-[12px] text-ink-2">{t('setup.intro')}</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Toggle checked={opts.docker} onChange={set('docker')} label={t('setup.docker')} />
          <Toggle checked={opts.journal} onChange={set('journal')} label={t('setup.journal')} />
          <Toggle checked={opts.maint} onChange={set('maint')} label={t('setup.maint')} />
          {asterisk ? <Toggle checked={opts.asterisk} onChange={set('asterisk')} label={t('setup.asterisk')} /> : null}
        </div>
        <Alert kind="warn">{t('setup.rootNote')}</Alert>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-2">{t('setup.pubKey')}</span>
          <div className="flex gap-2">
            <input className="flex-1 font-mono text-[11px]" value={pubKey} placeholder={t('setup.pubKeyPh')} onChange={(e) => setPubKey(e.target.value)} spellCheck={false} />
            {keySource ? <Button onClick={() => void fromKey()}>{t('setup.fromKey')}</Button> : null}
          </div>
        </label>
        {keyError ? <Alert kind="error">{keyError}</Alert> : null}
        {!keyOk ? <Alert kind="error">{t('setup.badKey')}</Alert> : null}

        {userOk ? (
          script ? (
            <div className="relative">
              <pre className="m-0 max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-ink-2">{script}</pre>
              <div className="absolute top-2 right-2">
                <Button small onClick={() => void copy()}>
                  {copied ? t('setup.copied') : t('setup.copy')}
                </Button>
              </div>
            </div>
          ) : null
        ) : (
          <Alert kind="info">{t('setup.needUser')}</Alert>
        )}
      </div>
    </details>
  )
}
