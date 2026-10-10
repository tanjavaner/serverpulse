import { useEffect, useState, type ReactNode } from 'react'
import { SETTINGS_LIMITS, type AppSettings, type AppSnapshot, type RemoteNotifySettings, type UpdateStatus } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { Alert, Button, Card, Field, NumField, SectionTitle, Toggle } from '../components/ui'
import { cleanErr } from './ServerForm'
import { TransferCard } from './TransferCard'

type IntervalKey = keyof AppSettings['intervals']
type ThresholdKey = keyof AppSettings['thresholds']

export function SettingsView({ snap }: { snap: AppSnapshot }): ReactNode {
  // Taslak yalnızca açılışta ve kayıttan sonra snapshot'tan alınır; snapshot birkaç saniyede bir geldiği için
  // her gelişte kopyalanırsa kaydedilmemiş değişiklikler silinir.
  const [s, setS] = useState<AppSettings>(snap.settings)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setI = (k: IntervalKey, v: number): void => setS((prev) => ({ ...prev, intervals: { ...prev.intervals, [k]: v } }))
  const setT = (k: ThresholdKey, v: number): void => setS((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [k]: v } }))
  const numI = (k: IntervalKey): ReactNode => <NumField value={s.intervals[k]} min={SETTINGS_LIMITS.intervals[k][0]} max={SETTINGS_LIMITS.intervals[k][1]} onChange={(v) => setI(k, v)} />
  const numT = (k: ThresholdKey): ReactNode => <NumField value={s.thresholds[k]} min={SETTINGS_LIMITS.thresholds[k][0]} max={SETTINGS_LIMITS.thresholds[k][1]} onChange={(v) => setT(k, v)} />

  const flashSaved = (): void => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const save = async (): Promise<void> => {
    setError(null)
    try {
      setS(await api.invoke('settings:save', s))
      flashSaved()
    } catch (e) {
      setError(cleanErr(e))
    }
  }

  // Anahtar/tema değişiklikleri anında uygulanır; taslaktaki diğer (kaydedilmemiş) alanlara dokunulmaz
  const instant = (patch: Partial<AppSettings>): void => {
    setS((prev) => ({ ...prev, ...patch }))
    setError(null)
    api.invoke('settings:save', patch).then(flashSaved, (e: unknown) => setError(cleanErr(e)))
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-bold">{t('nav.settings')}</h1>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('settings.general')}</SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('settings.theme')}>
            <select value={s.theme} onChange={(e) => instant({ theme: e.target.value as AppSettings['theme'] })} className="w-48">
              <option value="system">{t('common.system')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
          </Field>
          <Field label={t('settings.language')}>
            <select value={s.language} onChange={(e) => instant({ language: e.target.value as AppSettings['language'] })} className="w-48">
              <option value="system">{t('common.system')}</option>
              <option value="tr">Türkçe</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
        <Toggle checked={s.notifications} onChange={(v) => instant({ notifications: v })} label={t('settings.notifications')} hint={t('settings.notificationsHint')} />
        <Toggle checked={s.openAtLogin} onChange={(v) => instant({ openAtLogin: v })} label={t('settings.openAtLogin')} hint={t('settings.openAtLoginHint')} />
        <Toggle checked={s.widgetAlwaysOnTop} onChange={(v) => instant({ widgetAlwaysOnTop: v })} label={t('settings.widgetOnTop')} />
        <Toggle checked={s.widgetShowOnStart} onChange={(v) => instant({ widgetShowOnStart: v })} label={t('settings.widgetOnStart')} />
        <Toggle
          checked={s.allowActions}
          onChange={(v) => instant({ allowActions: v })}
          label={t('settings.allowActions')}
          hint={t('settings.allowActionsHint')}
        />
        <Toggle checked={s.allowTerminal} onChange={(v) => instant({ allowTerminal: v })} label={t('settings.allowTerminal')} hint={t('settings.allowTerminalHint')} />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('settings.intervals')}</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label={t('settings.fast')} hint="host, docker">
            {numI('fastSec')}
          </Field>
          <Field label={t('settings.medium')} hint={t('settings.mediumHint')}>
            {numI('mediumSec')}
          </Field>
          <Field label={t('settings.slow')} hint="docker system df, inode, güvenlik">
            {numI('slowSec')}
          </Field>
          <Field label={t('settings.sslHours')}>{numI('sslHours')}</Field>
        </div>
        <Toggle checked={s.lightMode} onChange={(v) => instant({ lightMode: v })} label={t('settings.lightMode')} hint={t('settings.lightModeHint')} />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('settings.thresholds')}</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Disk (%)">{numT('diskPct')}</Field>
          <Field label="RAM (%)">{numT('ramPct')}</Field>
          <Field label={t('settings.ramDuration')}>{numT('ramDurationSec')}</Field>
          <Field label={t('settings.sslDays')}>{numT('sslDays')}</Field>
          <Field label={t('settings.httpTimeout')}>{numT('httpTimeoutSec')}</Field>
          <Field label={t('settings.unreachable')}>{numT('unreachableAttempts')}</Field>
          <Field label={t('settings.checkFail')} hint={t('settings.checkFailHint')}>
            {numT('checkFailAttempts')}
          </Field>
          <Field label={t('settings.debounce')} hint={t('settings.debounceHint')}>
            {numT('debounceSec')}
          </Field>
          <Field label={t('settings.retention')}>
            <NumField
              value={s.retentionHours}
              min={SETTINGS_LIMITS.retentionHours[0]}
              max={SETTINGS_LIMITS.retentionHours[1]}
              onChange={(v) => setS((prev) => ({ ...prev, retentionHours: v }))}
            />
          </Field>
        </div>
      </Card>

      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {saved ? <span className="text-[12px] text-good">{t('common.saved')}</span> : null}
      </div>

      <RemoteNotifyCard settings={snap.settings.remoteNotify} />

      <TransferCard />

      <UpdatesCard />
    </div>
  )
}

function RemoteNotifyCard({ settings }: { settings: RemoteNotifySettings }): ReactNode {
  const [tgOn, setTgOn] = useState(settings.telegram.enabled)
  const [chatId, setChatId] = useState(settings.telegram.chatId)
  const [token, setToken] = useState('')
  const [commands, setCommands] = useState(settings.telegram.commands)
  const [daily, setDaily] = useState(settings.telegram.dailySummary)
  const [summaryTime, setSummaryTime] = useState(settings.telegram.summaryTime)
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
        telegram: { enabled: tgOn, chatId, token: token || undefined, clearToken: extra.clearToken, commands, dailySummary: daily, summaryTime },
        webhook: { enabled: whOn, url: url || undefined, clearUrl: extra.clearUrl }
      })
      setToken('')
      setUrl('')
      if (extra.clearToken) setTgOn(false)
      if (extra.clearUrl) setWhOn(false)
      return t('rn.saved')
    })

  const test = (): Promise<void> =>
    run(async () => {
      const rs = await api.invoke('notify:test')
      const bad = rs.filter((r) => !r.ok)
      if (bad.length) throw new Error(bad.map((r) => `${r.channel}: ${r.error}`).join(' | '))
      return t('rn.testSent', { ch: rs.map((r) => r.channel).join(', ') })
    })

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>{t('rn.title')}</SectionTitle>
      <div className="text-[12px] text-ink-2">
        {t('rn.intro')}
      </div>

      <Toggle checked={tgOn} onChange={setTgOn} label="Telegram" hint={t('rn.telegramHint')} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Bot token" hint={settings.telegram.hasToken ? t('rn.storedHint') : undefined}>
          <input type="password" autoComplete="off" placeholder={settings.telegram.hasToken ? '••••••••' : '123456789:AA...'} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Chat ID">
          <input value={chatId} placeholder={t('rn.chatIdPh')} onChange={(e) => setChatId(e.target.value)} />
        </Field>
      </div>

      {tgOn ? (
        <div className="flex flex-col gap-2 border-l-2 border-line pl-3">
          <Toggle checked={commands} onChange={setCommands} label={t('rn.commands')} hint={t('rn.commandsHint')} />
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={daily} onChange={setDaily} label={t('rn.daily')} hint={t('rn.dailyHint')} />
            {daily ? (
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                {t('rn.dailyTime')}
                <input type="time" value={summaryTime} onChange={(e) => setSummaryTime(e.target.value)} />
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <Toggle checked={whOn} onChange={setWhOn} label={t('rn.webhook')} hint="JSON POST: event, severity, title, detail, server, text, content." />
      <Field label="Webhook URL" hint={settings.webhook.hasUrl ? t('rn.storedHint') : undefined}>
        <input type="password" autoComplete="off" placeholder={settings.webhook.hasUrl ? '••••••••' : 'https://...'} value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>

      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        <Button disabled={busy || (!settings.telegram.hasToken && !settings.webhook.hasUrl)} onClick={() => void test()}>
          {t('rn.sendTest')}
        </Button>
        {settings.telegram.hasToken ? (
          <Button disabled={busy} onClick={() => void save({ clearToken: true })}>
            {t('rn.deleteToken')}
          </Button>
        ) : null}
        {settings.webhook.hasUrl ? (
          <Button disabled={busy} onClick={() => void save({ clearUrl: true })}>
            {t('rn.deleteUrl')}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'disabled':
      return t('upd.disabled')
    case 'idle':
      return t('upd.idle')
    case 'checking':
      return t('upd.checking')
    case 'downloading':
      return t('upd.downloading', { v: u.version ?? '?', p: u.percent ?? 0 })
    case 'ready':
      return t('upd.ready', { v: u.version })
    case 'uptodate':
      return t('upd.uptodate')
    case 'error':
      return t('upd.error', { e: u.error ?? t('upd.unknownError') })
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
      <SectionTitle>{t('upd.title')}</SectionTitle>
      <div className="text-[13px]">
        {t('upd.installed')} <b>v{u.current}</b>
      </div>
      <div className={`text-[12px] ${u.state === 'error' ? 'text-critical' : 'text-ink-2'}`}>{updateText(u)}</div>
      <div className="flex items-center gap-2">
        {u.state === 'ready' ? (
          <Button variant="primary" onClick={() => void api.invoke('update:install')}>
            {t('upd.restartInstall')}
          </Button>
        ) : (
          <Button disabled={u.state === 'disabled' || busy} onClick={() => void api.invoke('update:check')}>
            {t('upd.checkNow')}
          </Button>
        )}
      </div>
    </Card>
  )
}
