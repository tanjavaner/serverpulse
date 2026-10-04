import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, AppSnapshot, RemoteNotifySettings, UpdateStatus } from '@shared/types'
import { api } from '../lib/api'
import { Alert, Button, Card, Field, SectionTitle, Toggle } from '../components/ui'
import { cleanErr } from './ServerForm'

export function SettingsView({ snap }: { snap: AppSnapshot }): ReactNode {
  const [s, setS] = useState<AppSettings>(snap.settings)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setS(snap.settings), [snap.settings])

  const num = (v: string, min: number, max: number): number => Math.max(min, Math.min(max, Number(v) || min))
  const setI = (k: keyof AppSettings['intervals'], v: number): void => setS({ ...s, intervals: { ...s.intervals, [k]: v } })
  const setT = (k: keyof AppSettings['thresholds'], v: number): void => setS({ ...s, thresholds: { ...s.thresholds, [k]: v } })

  const save = async (patch: Partial<AppSettings> = s): Promise<void> => {
    setError(null)
    try {
      setS(await api.invoke('settings:save', patch))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(cleanErr(e))
    }
  }

  // Anahtar/tema değişiklikleri anında uygulanır
  const instant = (patch: Partial<AppSettings>): void => {
    setS({ ...s, ...patch })
    void save(patch)
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-bold">Ayarlar</h1>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Genel</SectionTitle>
        <Field label="Tema">
          <select value={s.theme} onChange={(e) => instant({ theme: e.target.value as AppSettings['theme'] })} className="w-48">
            <option value="system">Sistem</option>
            <option value="light">Açık</option>
            <option value="dark">Koyu</option>
          </select>
        </Field>
        <Toggle checked={s.notifications} onChange={(v) => instant({ notifications: v })} label="Masaüstü bildirimleri" hint="Sadece durum değiştiğinde (debounce sonrası) gönderilir." />
        <Toggle checked={s.openAtLogin} onChange={(v) => instant({ openAtLogin: v })} label="Bilgisayar açılınca başlat" hint="Sadece kurulu (paketli) sürümde etkilidir." />
        <Toggle checked={s.widgetAlwaysOnTop} onChange={(v) => instant({ widgetAlwaysOnTop: v })} label="Widget her zaman üstte" />
        <Toggle checked={s.widgetShowOnStart} onChange={(v) => instant({ widgetShowOnStart: v })} label="Açılışta widget'ı göster" />
        <Toggle
          checked={s.allowActions}
          onChange={(v) => instant({ allowActions: v })}
          label="Yönetim eylemlerine izin ver (container restart, sunucu bakımı)"
          hint="Her eylem ayrıca yerel bir onay penceresi ister. Varsayılan: kapalı."
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Toplama aralıkları</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Hızlı (sn)" hint="host, docker">
            <input type="number" value={s.intervals.fastSec} onChange={(e) => setI('fastSec', num(e.target.value, 2, 300))} />
          </Field>
          <Field label="Orta (sn)" hint="erişim, http, systemd, db, asterisk">
            <input type="number" value={s.intervals.mediumSec} onChange={(e) => setI('mediumSec', num(e.target.value, 10, 3600))} />
          </Field>
          <Field label="Yavaş (sn)" hint="docker system df">
            <input type="number" value={s.intervals.slowSec} onChange={(e) => setI('slowSec', num(e.target.value, 60, 86400))} />
          </Field>
          <Field label="SSL (saat)">
            <input type="number" value={s.intervals.sslHours} onChange={(e) => setI('sslHours', num(e.target.value, 1, 168))} />
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Alarm eşikleri</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Disk (%)">
            <input type="number" value={s.thresholds.diskPct} onChange={(e) => setT('diskPct', num(e.target.value, 50, 99))} />
          </Field>
          <Field label="RAM (%)">
            <input type="number" value={s.thresholds.ramPct} onChange={(e) => setT('ramPct', num(e.target.value, 50, 99))} />
          </Field>
          <Field label="RAM süresi (sn)">
            <input type="number" value={s.thresholds.ramDurationSec} onChange={(e) => setT('ramDurationSec', num(e.target.value, 0, 3600))} />
          </Field>
          <Field label="SSL (gün)">
            <input type="number" value={s.thresholds.sslDays} onChange={(e) => setT('sslDays', num(e.target.value, 1, 90))} />
          </Field>
          <Field label="HTTP zaman aşımı (sn)">
            <input type="number" value={s.thresholds.httpTimeoutSec} onChange={(e) => setT('httpTimeoutSec', num(e.target.value, 2, 60))} />
          </Field>
          <Field label="Erişilemez: ardışık deneme">
            <input type="number" value={s.thresholds.unreachableAttempts} onChange={(e) => setT('unreachableAttempts', num(e.target.value, 1, 10))} />
          </Field>
          <Field label="Debounce (sn)" hint="Sorun bu süre boyunca sürerse bildirilir">
            <input type="number" value={s.thresholds.debounceSec} onChange={(e) => setT('debounceSec', num(e.target.value, 0, 600))} />
          </Field>
          <Field label="Geçmiş saklama (saat)">
            <input type="number" value={s.retentionHours} onChange={(e) => setS({ ...s, retentionHours: num(e.target.value, 1, 24 * 30) })} />
          </Field>
        </div>
      </Card>

      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()}>
          Kaydet
        </Button>
        {saved ? <span className="text-[12px] text-good">✓ Kaydedildi</span> : null}
      </div>

      <RemoteNotifyCard settings={snap.settings.remoteNotify} />

      <UpdatesCard />
    </div>
  )
}

function RemoteNotifyCard({ settings }: { settings: RemoteNotifySettings }): ReactNode {
  const [tgOn, setTgOn] = useState(settings.telegram.enabled)
  const [chatId, setChatId] = useState(settings.telegram.chatId)
  const [token, setToken] = useState('')
  const [whOn, setWhOn] = useState(settings.webhook.enabled)
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      setMsg({ kind: 'ok', text: await fn() })
    } catch (e) {
      setMsg({ kind: 'error', text: cleanErr(e) })
    } finally {
      setBusy(false)
    }
  }

  const save = (extra: { clearToken?: boolean; clearUrl?: boolean } = {}): Promise<void> =>
    run(async () => {
      await api.invoke('notify:save', {
        telegram: { enabled: tgOn, chatId, token: token || undefined, clearToken: extra.clearToken },
        webhook: { enabled: whOn, url: url || undefined, clearUrl: extra.clearUrl }
      })
      setToken('')
      setUrl('')
      if (extra.clearToken) setTgOn(false)
      if (extra.clearUrl) setWhOn(false)
      return 'Kaydedildi'
    })

  const test = (): Promise<void> =>
    run(async () => {
      const rs = await api.invoke('notify:test')
      const bad = rs.filter((r) => !r.ok)
      if (bad.length) throw new Error(bad.map((r) => `${r.channel}: ${r.error}`).join(' | '))
      return `Test mesajı gönderildi (${rs.map((r) => r.channel).join(', ')})`
    })

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>Harici bildirimler</SectionTitle>
      <div className="text-[12px] text-ink-2">
        Alarm açıldığında ve düzeldiğinde Telegram/webhook'a da mesaj gönderilir. Token ve URL işletim sisteminin güvenli depolamasında şifreli saklanır. Uygulama çalışıyor olmalıdır.
      </div>

      <Toggle checked={tgOn} onChange={setTgOn} label="Telegram" hint="@BotFather ile bot oluşturun, bota bir mesaj yazın; chat ID'yi @userinfobot veya getUpdates ile öğrenin." />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Bot token" hint={settings.telegram.hasToken ? 'Kayıtlı. Değiştirmek için yeni değer yazın.' : undefined}>
          <input type="password" autoComplete="off" placeholder={settings.telegram.hasToken ? '••••••••' : '123456789:AA...'} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Chat ID">
          <input value={chatId} placeholder="123456789 veya -100..." onChange={(e) => setChatId(e.target.value)} />
        </Field>
      </div>

      <Toggle checked={whOn} onChange={setWhOn} label="Webhook (Slack, Discord, Mattermost, özel)" hint="JSON POST: event, severity, title, detail, server, text, content." />
      <Field label="Webhook URL" hint={settings.webhook.hasUrl ? 'Kayıtlı. Değiştirmek için yeni değer yazın.' : undefined}>
        <input type="password" autoComplete="off" placeholder={settings.webhook.hasUrl ? '••••••••' : 'https://...'} value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>

      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          Kaydet
        </Button>
        <Button disabled={busy || (!settings.telegram.hasToken && !settings.webhook.hasUrl)} onClick={() => void test()}>
          Test mesajı gönder
        </Button>
        {settings.telegram.hasToken ? (
          <Button disabled={busy} onClick={() => void save({ clearToken: true })}>
            Telegram token'ını sil
          </Button>
        ) : null}
        {settings.webhook.hasUrl ? (
          <Button disabled={busy} onClick={() => void save({ clearUrl: true })}>
            Webhook URL'sini sil
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'disabled':
      return 'Geliştirme modunda otomatik güncelleme kapalı.'
    case 'idle':
      return 'Henüz denetlenmedi.'
    case 'checking':
      return 'Denetleniyor…'
    case 'downloading':
      return `v${u.version ?? '?'} indiriliyor… %${u.percent ?? 0}`
    case 'ready':
      return `v${u.version} indirildi. Yeniden başlatınca kurulur (kapatınca da otomatik kurulur).`
    case 'uptodate':
      return 'Güncel sürümü kullanıyorsunuz.'
    case 'error':
      return `Denetim başarısız: ${u.error ?? 'bilinmeyen hata'}`
  }
}

function UpdatesCard(): ReactNode {
  const [u, setU] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.invoke('update:status').then(setU)
    return api.onUpdate(setU)
  }, [])
  if (!u) return null
  const busy = u.state === 'checking' || u.state === 'downloading'
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>Güncellemeler</SectionTitle>
      <div className="text-[13px]">
        Kurulu sürüm: <b>v{u.current}</b>
      </div>
      <div className={`text-[12px] ${u.state === 'error' ? 'text-critical' : 'text-ink-2'}`}>{updateText(u)}</div>
      <div className="flex items-center gap-2">
        {u.state === 'ready' ? (
          <Button variant="primary" onClick={() => void api.invoke('update:install')}>
            Yeniden başlat ve güncelle
          </Button>
        ) : (
          <Button disabled={u.state === 'disabled' || busy} onClick={() => void api.invoke('update:check')}>
            Şimdi denetle
          </Button>
        )}
      </div>
    </Card>
  )
}
