import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSnapshot, BackupInfo, MaintResult, MaintStatus, MaintStep, PostcheckResult, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { ago, dateTime, fmtBytes } from '../lib/format'
import { useNow } from '../lib/hooks'
import { Alert, Button, Card, SectionTitle } from '../components/ui'
import { cleanErr } from './ServerForm'
import { LiveLog } from './LiveLog'
import { pushLocal, stepLabel, useMaintLog } from '../lib/maintLog'

const DAY_MS = 24 * 3600_000

type Panel = null | 'reboot' | 'upgradeNoBackup'

export function MaintenanceTab({ snap, server }: { snap: AppSnapshot; server: ServerConfig }): ReactNode {
  const allow = snap.settings.allowActions
  const [status, setStatus] = useState<MaintStatus | null>(null)
  const [busy, setBusy] = useState<MaintStep | 'wizard' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [post, setPost] = useState<PostcheckResult | null>(null)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [panel, setPanel] = useState<Panel>(null)
  const [rebootText, setRebootText] = useState('')
  const [restoreText, setRestoreText] = useState('')
  const wizardRef = useRef(false)
  const logs = useMaintLog(server.id)
  const now = useNow(10000)
  const running = snap.states[server.id]?.maintenance

  const loadBackups = (): void => void api.invoke('maint:listBackups', server.id).then(setBackups)
  useEffect(loadBackups, [server.id])

  const report = (step: MaintStep, r: MaintResult): boolean => {
    if (r.cancelled) {
      setMsg({ kind: 'warn', text: t('maint.cancelled', { s: stepLabel(step) }) })
      return false
    }
    setMsg(
      r.ok
        ? { kind: 'ok', text: r.summary ? t('maint.doneSummary', { s: stepLabel(step), sum: r.summary }) : t('maint.done', { s: stepLabel(step) }) }
        : { kind: 'error', text: t('maint.failed', { s: stepLabel(step), e: r.error ?? '' }) }
    )
    return r.ok
  }

  /** Tek adım çalıştırır; başarı durumunu döner. */
  const step = async (s: MaintStep, fn: () => Promise<MaintResult>): Promise<boolean> => {
    setMsg(null)
    if (!wizardRef.current) setBusy(s)
    pushLocal(server.id, s, t('maint.started', { s: stepLabel(s) }))
    try {
      const r = await fn()
      return report(s, r)
    } catch (e) {
      setMsg({ kind: 'error', text: cleanErr(e) })
      return false
    } finally {
      if (!wizardRef.current) setBusy(null)
    }
  }

  const runStatus = (): Promise<boolean> =>
    step('status', async () => {
      const r = await api.invoke('maint:status', server.id)
      setStatus(r)
      return r.ok ? { ok: true, summary: r.error } : { ok: false, error: r.error }
    })

  const runBackup = (): Promise<boolean> =>
    step('backup', async () => {
      const r = await api.invoke('maint:backup', server.id)
      loadBackups()
      if (r.ok) setStatus((s) => (s ? { ...s, lastBackupAt: Date.now() } : s))
      return r
    })

  const runUpgrade = (): Promise<boolean> =>
    step('upgrade', async () => {
      setPanel(null)
      const r = await api.invoke('maint:upgrade', server.id)
      if (r.ok) await api.invoke('maint:status', server.id).then(setStatus).catch(() => undefined)
      return r
    })

  const runReboot = (): Promise<boolean> =>
    step('reboot', async () => {
      const text = rebootText
      setPanel(null)
      setRebootText('')
      const r = await api.invoke('maint:reboot', server.id, text)
      if (!r.cancelled && (r.containers.length || r.kernel)) setPost(r)
      return r
    })

  const runPostcheck = (): Promise<boolean> =>
    step('postcheck', async () => {
      const r = await api.invoke('maint:postcheck', server.id)
      setPost(r)
      return r
    })

  const runAutoremove = (): Promise<boolean> => step('autoremove', () => api.invoke('maint:autoremove', server.id))

  const runRestore = (): Promise<boolean> =>
    step('restore', async () => {
      const text = restoreText
      setRestoreText('')
      return api.invoke('maint:restore', server.id, text)
    })

  const recentBackup = !!status?.lastBackupAt && now - status.lastBackupAt < DAY_MS

  const askUpgrade = (): void => {
    if (!recentBackup) setPanel('upgradeNoBackup')
    else void runUpgrade()
  }

  /** Durum → Yedek → Güncelle, ardından reboot onay paneli. Bir adım başarısızsa durur. */
  const wizard = async (): Promise<void> => {
    wizardRef.current = true
    setBusy('wizard')
    try {
      pushLocal(server.id, 'status', t('maint.wizardHeader'))
      if (!(await runStatus())) return
      if (!(await runBackup())) return
      if (!(await runUpgrade())) return
      pushLocal(server.id, 'reboot', t('maint.wizardRebootWait'))
      setPanel('reboot')
    } finally {
      wizardRef.current = false
      setBusy(null)
    }
  }

  const disabled = busy !== null || !!running
  const secCount = status?.upgradable.filter((p) => p.security).length ?? 0
  // apt olmayan dağıtımlarda paket işlemleri desteklenmez (durum kontrolünden sonra bilinir)
  const noApt = status?.pkgManager === 'unsupported'
  // Durum kontrolünde şifresiz sudo izni yoksa ilgili butonlar kapanır (neden, durum kartındaki uyarıda yazar)
  const upgradeBlock = noApt ? t('maint.aptOnly') : status?.sudoApt === false ? t('mm.noSudoApt') : undefined
  const rebootBlock = status?.sudoReboot === false ? t('mm.noSudoReboot') : undefined

  return (
    <div className="flex flex-col gap-3">
      {!allow ? (
        <Alert kind="info">
          {t('maint.needActions1')} <b>{t('maint.needActionsPath')}</b> {t('maint.needActions2')}
        </Alert>
      ) : null}
      {running && !busy ? <Alert kind="warn">{t('maint.running', { s: stepLabel(running.step), ago: ago(running.since, now) })}</Alert> : null}
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}

      <Card>
        <SectionTitle>{t('maint.actions')}</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={disabled} onClick={() => void runStatus()}>
            {busy === 'status' ? t('maint.checking') : t('maint.btnStatus')}
          </Button>
          <Button disabled={disabled || !allow} onClick={() => void runBackup()}>
            {busy === 'backup' ? t('maint.backingUp') : t('maint.btnBackup')}
          </Button>
          <Button disabled={disabled || !allow || !!upgradeBlock} onClick={askUpgrade} title={upgradeBlock}>
            {busy === 'upgrade' ? t('maint.upgrading') : t('maint.btnUpgrade')}
          </Button>
          <Button variant="danger" disabled={disabled || !allow || !!rebootBlock} onClick={() => setPanel('reboot')} title={rebootBlock}>
            {busy === 'reboot' ? t('maint.rebooting') : t('maint.btnReboot')}
          </Button>
          <Button disabled={disabled} onClick={() => void runPostcheck()}>
            {busy === 'postcheck' ? t('maint.checking') : t('maint.btnPostcheck')}
          </Button>
          <span className="mx-1 w-px self-stretch bg-line" />
          <Button disabled={disabled || !allow} onClick={() => void wizard()} title={t('maint.wizardTitle')}>
            {busy === 'wizard' ? t('maint.wizardRunning') : t('maint.btnWizard')}
          </Button>
        </div>

        {panel === 'upgradeNoBackup' ? (
          <div className="mt-3">
            <Alert kind="warn">
              <div className="mb-2">
                {t('maint.noRecentBackup')}
                {status ? '' : ` ${t('maint.noStatusYet')}`}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  small
                  variant="primary"
                  onClick={() => {
                    setPanel(null)
                    void runBackup().then((ok) => ok && runUpgrade())
                  }}
                >
                  {t('maint.backupThenUpgrade')}
                </Button>
                <Button small variant="danger" onClick={() => void runUpgrade()}>
                  {t('maint.upgradeAnyway')}
                </Button>
                <Button small variant="ghost" onClick={() => setPanel(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </Alert>
          </div>
        ) : null}

        {panel === 'reboot' ? (
          <div className="mt-3">
            <Alert kind="error">
              <div className="font-semibold">{t('maint.willReboot', { name: server.name })}</div>
              <div>
                {t('maint.rebootWarning')}
                {server.asterisk ? ` ${t('maint.callsWarning')}` : ''}
              </div>
              {snap.states[server.id]?.asterisk?.activeCalls != null ? <div>{t('maint.activeCalls', { n: snap.states[server.id]?.asterisk?.activeCalls })}</div> : null}
              {status?.noRestart.length ? (
                <div className="mt-1">
                  {t('maint.noRestartList', { list: status.noRestart.join(', ') })}
                </div>
              ) : !status ? (
                <div className="mt-1 text-ink-2">{t('maint.runStatusFirst')}</div>
              ) : null}
              {status?.expectedKernel ? <div className="mt-1">{t('maint.expectedKernel', { k: status.expectedKernel })}</div> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input className="w-40 font-mono" placeholder={t('maint.typeReboot')} value={rebootText} onChange={(e) => setRebootText(e.target.value)} autoFocus />
                <Button small variant="danger" disabled={rebootText !== 'REBOOT' || disabled} onClick={() => void runReboot()}>
                  {t('maint.reboot')}
                </Button>
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    setPanel(null)
                    setRebootText('')
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </Alert>
          </div>
        ) : null}
      </Card>

      {status ? <StatusView st={status} secCount={secCount} now={now} /> : null}
      {post ? <PostcheckView r={post} allow={allow} disabled={disabled} onAutoremove={() => void runAutoremove()} /> : null}

      <LiveLog lines={logs} />

      <Card>
        <SectionTitle
          right={
            <Button small variant="ghost" onClick={() => void api.invoke('maint:openBackupDir', server.id)}>
              {t('maint.openFolder')}
            </Button>
          }
        >
          {t('maint.localBackups', { n: backups.length })}
        </SectionTitle>
        {backups.length ? (
          <table className="tnum w-full text-[12px]">
            <tbody>
              {backups.slice(0, 10).map((b) => (
                <tr key={b.file} className="border-t border-line">
                  <td className="py-1.5 font-mono">{b.file}</td>
                  <td className="py-1.5 text-right">{fmtBytes(b.size)}</td>
                  <td className="py-1.5 text-right text-ink-2">{dateTime(b.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[12px] text-muted">{t('maint.noBackups')}</div>
        )}
      </Card>

      <details className="rounded-xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">{t('maint.restoreSummary')}</summary>
        <div className="mt-3 flex flex-col gap-2">
          <Alert kind="error">
            <b>{t('maint.restoreWarn1')}</b>{' '}
            {t('maint.restoreWarn2', { target: status?.pg ? `${status.pg.container} (${status.pg.user})` : 'PostgreSQL container' })}
          </Alert>
          <div className="flex flex-wrap items-center gap-2">
            <input className="w-40 font-mono" placeholder={t('maint.typeRestore')} value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
            <Button variant="danger" disabled={restoreText !== 'RESTORE' || disabled || !allow} onClick={() => void runRestore()}>
              {busy === 'restore' ? t('maint.restoring') : t('maint.pickRestore')}
            </Button>
          </div>
        </div>
      </details>
    </div>
  )
}

function StatusView({ st, secCount, now }: { st: MaintStatus; secCount: number; now: number }): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card>
        <SectionTitle>{t('maint.system')}</SectionTitle>
        {st.error ? (
          <div className="mb-2">
            <Alert kind={st.ok ? 'warn' : 'error'}>{st.error}</Alert>
          </div>
        ) : null}
        <table className="w-full text-[12px]">
          <tbody>
            {st.os ? <Row k={t('maint.os')} v={st.os} /> : null}
            <Row k={t('maint.kernel')} v={<span className="font-mono">{st.kernel ?? '—'}</span>} />
            <Row
              k="Reboot"
              v={
                st.rebootRequired ? (
                  <span className="font-semibold text-warning">{t('maint.required')}{st.expectedKernel ? ` → ${st.expectedKernel}` : ''}</span>
                ) : (
                  <span className="text-good">{t('maint.notRequired')}</span>
                )
              }
            />
            {st.rebootPkgs.length ? <Row k={t('maint.reason')} v={<span className="font-mono text-[11px]">{st.rebootPkgs.join(', ')}</span>} /> : null}
            <Row k="Uptime" v={<span className="text-[11px]">{st.uptime ?? '—'}</span>} />
            <Row k="Disk (/)" v={<span className="font-mono text-[11px]">{st.diskRoot ?? '—'}</span>} />
            <Row k="PostgreSQL" v={st.pg ? `${st.pg.container} · ${st.pg.user}` : <span className="text-warning">{t('maint.pgNotFound')}</span>} />
            <Row
              k={t('maint.lastBackup')}
              v={st.lastBackupAt ? <span className={now - st.lastBackupAt < DAY_MS ? 'text-good' : 'text-warning'}>{ago(st.lastBackupAt, now)}</span> : <span className="text-warning">{t('common.none')}</span>}
            />
          </tbody>
        </table>
        {st.noRestart.length ? (
          <div className="mt-2">
            <Alert kind="warn">
              {t('maint.noRestartShort', { list: st.noRestart.join(', ') })}
            </Alert>
          </div>
        ) : null}
      </Card>
      <Card>
        <SectionTitle>
          {secCount ? t('maint.pendingSec', { n: st.upgradable.length, s: secCount }) : t('maint.pending', { n: st.upgradable.length })}
        </SectionTitle>
        {st.upgradable.length ? (
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-[12px]">
              <tbody>
                {[...st.upgradable]
                  .sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name))
                  .map((p) => (
                    <tr key={p.name} className="border-t border-line">
                      <td className="py-1 font-medium">{p.name}</td>
                      <td className="py-1 font-mono text-[11px] text-ink-2">{p.version}</td>
                      <td className="py-1 text-right">
                        {p.security ? <span className="rounded bg-critical px-1.5 py-0.5 text-[10px] font-semibold text-white">{t('maint.security')}</span> : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12px] text-good">{t('maint.upToDate')}</div>
        )}
        <div className="mt-2 text-[11px] text-muted">{t('maint.runningContainers', { n: st.containers.length })}</div>
      </Card>
    </div>
  )
}

function PostcheckView({ r, allow, disabled, onAutoremove }: { r: PostcheckResult; allow: boolean; disabled: boolean; onAutoremove: () => void }): ReactNode {
  return (
    <Card>
      <SectionTitle
        right={
          <Button small disabled={disabled || !allow} onClick={onAutoremove} title={t('maint.autoremoveTitle')}>
            {t('maint.autoremoveBtn')}
          </Button>
        }
      >
        {t('maint.postcheckTitle')} {r.ok ? '✓' : '✕'}
      </SectionTitle>
      <div className="mb-2 text-[12px]">
        {t('maint.kernelLabel')} <span className="font-mono">{r.kernel ?? '—'}</span>{' '}
        {r.expectedKernel ? (r.kernelOk ? <span className="text-good">{t('maint.expectedOk')}</span> : <span className="text-critical">{t('maint.expectedBad', { k: r.expectedKernel })}</span>) : null}
        {' · '}reboot-required: {r.rebootRequired ? <span className="text-critical">{t('maint.stillThere')}</span> : <span className="text-good">{t('common.none')}</span>}
      </div>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
        {r.containers.map((c) => (
          <div key={c.name} className={`flex items-center gap-2 text-[12px] ${c.ok ? '' : 'font-semibold text-critical'}`}>
            <span>{c.ok ? '✓' : '✕'}</span>
            <span className="font-medium">{c.name}</span>
            <span className="truncate text-[11px] text-ink-2">{c.status}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }): ReactNode {
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 pr-3 whitespace-nowrap text-ink-2">{k}</td>
      <td className="py-1.5">{v}</td>
    </tr>
  )
}
