import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, BackupAllResult, ServerBackups } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { useMaintLog } from '../lib/maintLog'
import { Alert, Button, Card, Empty, SectionTitle } from '../components/ui'
import { cleanErr } from './ServerForm'
import { BackupSetList } from './BackupSetList'

const DAY_MS = 24 * 3600_000

export function BackupsView({ snap }: { snap: AppSnapshot }): ReactNode {
  const allow = snap.settings.allowActions
  const now = useNow(10000)
  const [list, setList] = useState<ServerBackups[]>([])
  const [busyAll, setBusyAll] = useState(false)
  const [busyOne, setBusyOne] = useState<string | null>(null)
  const [result, setResult] = useState<BackupAllResult | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)

  const load = (): void => void api.invoke('maint:listAllBackups').then(setList).catch(() => undefined)
  useEffect(load, [])
  // Bu ekran dışında başlatılan (ya da ekrandan çıkıp dönülen) yedekler bitince listeyi yenile
  useEffect(() => api.onMaint((e) => {
    if (e.done && e.step === 'backup') load()
  }), [])

  const runAll = async (): Promise<void> => {
    setBusyAll(true)
    setResult(null)
    setMsg(null)
    try {
      const r = await api.invoke('maint:backupAll')
      if (r.cancelled) setMsg({ kind: 'warn', text: t('backups.cancelled') })
      else if (r.error && !r.results.length) setMsg({ kind: 'error', text: r.error })
      else setResult(r)
    } catch (e) {
      setMsg({ kind: 'error', text: cleanErr(e) })
    } finally {
      setBusyAll(false)
      load()
    }
  }

  const runOne = async (serverId: string): Promise<void> => {
    setBusyOne(serverId)
    setResult(null)
    setMsg(null)
    try {
      const r = await api.invoke('maint:backup', serverId)
      const s = t('maint.step.backup')
      if (r.cancelled) setMsg({ kind: 'warn', text: t('maint.cancelled', { s }) })
      else if (r.ok) setMsg({ kind: 'ok', text: r.summary ? t('maint.doneSummary', { s, sum: r.summary }) : t('maint.done', { s }) })
      else setMsg({ kind: 'error', text: t('maint.failed', { s, e: r.error ?? '' }) })
    } catch (e) {
      setMsg({ kind: 'error', text: cleanErr(e) })
    } finally {
      setBusyOne(null)
      load()
    }
  }

  const busy = busyAll || busyOne !== null
  const count = (s: string): number => result?.results.filter((x) => x.status === s).length ?? 0
  const problems = result?.results.filter((x) => x.status === 'skipped' || x.status === 'error') ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">{t('nav.backups')}</h1>
        <Button variant="primary" disabled={busy || !allow || !list.length} onClick={() => void runAll()} title={allow ? undefined : t('backups.needActions')}>
          {busyAll ? t('backups.runningAll') : t('backups.backupAll')}
        </Button>
      </div>
      {!allow ? (
        <Alert kind="info">
          {t('maint.needActions1')} <b>{t('maint.needActionsPath')}</b> {t('maint.needActions2')}
        </Alert>
      ) : null}
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      {result ? (
        <Alert kind={count('error') || !result.ok ? 'warn' : 'ok'}>
          <div className="font-semibold">{t('backups.summary', { ok: count('ok'), partial: count('partial'), skipped: count('skipped'), error: count('error') })}</div>
          {problems.map((p) => (
            <div key={p.serverId} className="mt-0.5">
              <b>{p.name}</b> · {p.status === 'skipped' ? t('backups.skipped') : t('backups.error')}
              {p.error ? `: ${p.error}` : ''}
            </div>
          ))}
        </Alert>
      ) : null}

      {!list.length ? <Empty>{t('backups.noServers')}</Empty> : null}
      {list.map((sb) => {
        const stale = !sb.lastBackupAt || now - sb.lastBackupAt > DAY_MS
        const running = snap.states[sb.serverId]?.maintenance
        return (
          <Card key={sb.serverId}>
            <SectionTitle
              right={
                <div className="flex gap-2">
                  <Button small disabled={busy || !allow || !!running} onClick={() => void runOne(sb.serverId)} title={allow ? undefined : t('backups.needActions')}>
                    {busyOne === sb.serverId ? t('maint.backingUp') : t('backups.backupOne')}
                  </Button>
                  <Button small variant="ghost" onClick={() => void api.invoke('maint:openBackupDir', sb.serverId)}>
                    {t('maint.openFolder')}
                  </Button>
                </div>
              }
            >
              {sb.name}
            </SectionTitle>
            <div className={`mb-2 text-[12px] ${stale ? 'text-warning' : 'text-ink-2'}`}>
              {sb.lastBackupAt ? t('backups.last', { d: dateTime(sb.lastBackupAt), a: ago(sb.lastBackupAt, now) }) : t('backups.lastNone')}
            </div>
            {running ? <LiveLine serverId={sb.serverId} /> : null}
            <BackupSetList serverId={sb.serverId} sets={sb.sets} />
          </Card>
        )
      })}
    </div>
  )
}

function LiveLine({ serverId }: { serverId: string }): ReactNode {
  const lines = useMaintLog(serverId)
  const last = lines[lines.length - 1]
  return (
    <div className="mb-2 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-ink-2">
      ⏳ {t('backups.running')}
      {last ? ` · ${last.text}` : ''}
    </div>
  )
}
