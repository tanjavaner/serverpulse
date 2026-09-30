import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSnapshot, BackupInfo, MaintResult, MaintStatus, MaintStep, PostcheckResult, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { ago, dateTime, fmtBytes } from '../lib/format'
import { useNow } from '../lib/hooks'
import { Alert, Button, Card, SectionTitle } from '../components/ui'
import { cleanErr } from './ServerForm'

const STEP_LABEL: Record<MaintStep, string> = {
  status: 'Durum kontrolü',
  backup: 'Yedek',
  upgrade: 'Güncelleme',
  reboot: 'Reboot',
  postcheck: 'Reboot sonrası kontrol',
  autoremove: 'autoremove',
  restore: 'Geri yükleme'
}
const MAX_LINES = 3000
const DAY_MS = 24 * 3600_000

// Canlı çıktı sekme değişiminde kaybolmasın diye modül seviyesinde tutulur
interface LogLine {
  ts: number
  step: MaintStep
  text: string
}
const logStore = new Map<string, LogLine[]>()
const listeners = new Set<() => void>()
let subscribed = false
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  api.onMaint((e) => {
    if (e.line === undefined) return
    const arr = logStore.get(e.serverId) ?? []
    arr.push({ ts: Date.now(), step: e.step, text: e.line })
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES)
    logStore.set(e.serverId, arr)
    for (const l of listeners) l()
  })
}
function pushLocal(serverId: string, step: MaintStep, text: string): void {
  const arr = logStore.get(serverId) ?? []
  arr.push({ ts: Date.now(), step, text })
  logStore.set(serverId, arr)
  for (const l of listeners) l()
}

function useMaintLog(serverId: string): LogLine[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    ensureSubscribed()
    const l = (): void => setTick((x) => x + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return logStore.get(serverId) ?? []
}

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
      setMsg({ kind: 'warn', text: `${STEP_LABEL[step]} iptal edildi` })
      return false
    }
    setMsg(r.ok ? { kind: 'ok', text: `${STEP_LABEL[step]} tamamlandı${r.summary ? `: ${r.summary}` : ''}` } : { kind: 'error', text: `${STEP_LABEL[step]} başarısız: ${r.error ?? ''}` })
    return r.ok
  }

  /** Tek adım çalıştırır; başarı durumunu döner. */
  const step = async (s: MaintStep, fn: () => Promise<MaintResult>): Promise<boolean> => {
    setMsg(null)
    if (!wizardRef.current) setBusy(s)
    pushLocal(server.id, s, `▶ ${STEP_LABEL[s]} başladı`)
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
      pushLocal(server.id, 'status', '═══ Tam Bakım Sihirbazı ═══')
      if (!(await runStatus())) return
      if (!(await runBackup())) return
      if (!(await runUpgrade())) return
      pushLocal(server.id, 'reboot', 'Sihirbaz: reboot için onay bekleniyor (REBOOT yazın)')
      setPanel('reboot')
    } finally {
      wizardRef.current = false
      setBusy(null)
    }
  }

  const disabled = busy !== null || !!running
  const secCount = status?.upgradable.filter((p) => p.security).length ?? 0

  return (
    <div className="flex flex-col gap-3">
      {!allow ? (
        <Alert kind="info">
          Yedek, güncelleme, reboot ve geri yükleme için <b>Ayarlar → Yönetim eylemleri</b> açık olmalı. Durum kontrolü her zaman çalışır.
        </Alert>
      ) : null}
      {running && !busy ? <Alert kind="warn">Bu sunucuda şu an bir bakım işi sürüyor: {STEP_LABEL[running.step]} ({ago(running.since, now)} başladı)</Alert> : null}
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}

      <Card>
        <SectionTitle>İşlemler</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={disabled} onClick={() => void runStatus()}>
            {busy === 'status' ? 'Kontrol ediliyor…' : '1 · Durum kontrolü'}
          </Button>
          <Button disabled={disabled || !allow} onClick={() => void runBackup()}>
            {busy === 'backup' ? 'Yedekleniyor…' : '2 · Postgres yedeği al + indir'}
          </Button>
          <Button disabled={disabled || !allow} onClick={askUpgrade}>
            {busy === 'upgrade' ? 'Güncelleniyor…' : '3 · Paketleri güncelle'}
          </Button>
          <Button variant="danger" disabled={disabled || !allow} onClick={() => setPanel('reboot')}>
            {busy === 'reboot' ? 'Yeniden başlatılıyor…' : '4 · Yeniden başlat'}
          </Button>
          <Button disabled={disabled} onClick={() => void runPostcheck()}>
            {busy === 'postcheck' ? 'Kontrol ediliyor…' : '5 · Reboot sonrası kontrol'}
          </Button>
          <span className="mx-1 w-px self-stretch bg-line" />
          <Button disabled={disabled || !allow} onClick={() => void wizard()} title="Durum → Yedek → Güncelle → (onay) Reboot → Kontrol">
            {busy === 'wizard' ? 'Sihirbaz çalışıyor…' : '✦ Tam bakım sihirbazı'}
          </Button>
        </div>

        {panel === 'upgradeNoBackup' ? (
          <div className="mt-3">
            <Alert kind="warn">
              <div className="mb-2">
                Son 24 saatte başarılı bir veritabanı yedeği görünmüyor{status ? '' : ' (önce durum kontrolü yapılmadı)'}. Önce yedek almanız önerilir.
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
                  Önce yedek al, sonra güncelle
                </Button>
                <Button small variant="danger" onClick={() => void runUpgrade()}>
                  Yine de güncelle
                </Button>
                <Button small variant="ghost" onClick={() => setPanel(null)}>
                  Vazgeç
                </Button>
              </div>
            </Alert>
          </div>
        ) : null}

        {panel === 'reboot' ? (
          <div className="mt-3">
            <Alert kind="error">
              <div className="font-semibold">{server.name} yeniden başlatılacak.</div>
              <div>sesli-asistan-telephony üzerindeki aktif aramalar kopar; 1-3 dk kesinti olur.</div>
              {snap.states[server.id]?.asterisk?.activeCalls != null ? <div>Şu an aktif çağrı: {snap.states[server.id]?.asterisk?.activeCalls}</div> : null}
              {status?.noRestart.length ? (
                <div className="mt-1">
                  Restart politikası <b>no</b> olan, reboot sonrası <b>gelmeyecek</b> container'lar: {status.noRestart.join(', ')}
                </div>
              ) : !status ? (
                <div className="mt-1 text-ink-2">Geri gelmeyecek container listesi için önce durum kontrolü yapın (main process onay penceresinde de gösterilir).</div>
              ) : null}
              {status?.expectedKernel ? <div className="mt-1">Beklenen yeni çekirdek: {status.expectedKernel}</div> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input className="w-40 font-mono" placeholder="REBOOT yazın" value={rebootText} onChange={(e) => setRebootText(e.target.value)} autoFocus />
                <Button small variant="danger" disabled={rebootText !== 'REBOOT' || disabled} onClick={() => void runReboot()}>
                  Yeniden başlat
                </Button>
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    setPanel(null)
                    setRebootText('')
                  }}
                >
                  Vazgeç
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
              Klasörü aç
            </Button>
          }
        >
          Bu bilgisayardaki yedekler ({backups.length})
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
          <div className="text-[12px] text-muted">Henüz yedek indirilmedi.</div>
        )}
      </Card>

      <details className="rounded-xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Gelişmiş: yedeği geri yükle (acil durum)</summary>
        <div className="mt-3 flex flex-col gap-2">
          <Alert kind="error">
            <b>Mevcut veriyi etkiler ve geri alınamaz.</b> Seçilen pg_dumpall yedeği sunucuya yüklenip <code>psql -d postgres</code> ile{' '}
            {status?.pg ? `${status.pg.container} (${status.pg.user})` : 'PostgreSQL container'}'ına uygulanır. Var olan rol/veritabanı uyarıları normaldir.
          </Alert>
          <div className="flex flex-wrap items-center gap-2">
            <input className="w-40 font-mono" placeholder="RESTORE yazın" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
            <Button variant="danger" disabled={restoreText !== 'RESTORE' || disabled || !allow} onClick={() => void runRestore()}>
              {busy === 'restore' ? 'Geri yükleniyor…' : 'Yedek dosyası seç ve geri yükle…'}
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
        <SectionTitle>Sistem</SectionTitle>
        {st.error ? (
          <div className="mb-2">
            <Alert kind={st.ok ? 'warn' : 'error'}>{st.error}</Alert>
          </div>
        ) : null}
        <table className="w-full text-[12px]">
          <tbody>
            <Row k="Çalışan çekirdek" v={<span className="font-mono">{st.kernel ?? '—'}</span>} />
            <Row
              k="Reboot"
              v={
                st.rebootRequired ? (
                  <span className="font-semibold text-warning">Gerekli{st.expectedKernel ? ` → ${st.expectedKernel}` : ''}</span>
                ) : (
                  <span className="text-good">Gerekmiyor</span>
                )
              }
            />
            {st.rebootPkgs.length ? <Row k="Nedeni" v={<span className="font-mono text-[11px]">{st.rebootPkgs.join(', ')}</span>} /> : null}
            <Row k="Uptime" v={<span className="text-[11px]">{st.uptime ?? '—'}</span>} />
            <Row k="Disk (/)" v={<span className="font-mono text-[11px]">{st.diskRoot ?? '—'}</span>} />
            <Row k="PostgreSQL" v={st.pg ? `${st.pg.container} · ${st.pg.user}` : <span className="text-warning">bulunamadı</span>} />
            <Row
              k="Son yedek"
              v={st.lastBackupAt ? <span className={now - st.lastBackupAt < DAY_MS ? 'text-good' : 'text-warning'}>{ago(st.lastBackupAt, now)}</span> : <span className="text-warning">yok</span>}
            />
          </tbody>
        </table>
        {st.noRestart.length ? (
          <div className="mt-2">
            <Alert kind="warn">
              Restart politikası <b>no</b>, reboot sonrası gelmez: {st.noRestart.join(', ')}
            </Alert>
          </div>
        ) : null}
      </Card>
      <Card>
        <SectionTitle>
          Bekleyen güncellemeler ({st.upgradable.length}
          {secCount ? `, ${secCount} güvenlik` : ''})
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
                        {p.security ? <span className="rounded bg-critical px-1.5 py-0.5 text-[10px] font-semibold text-white">güvenlik</span> : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12px] text-good">Sistem güncel.</div>
        )}
        <div className="mt-2 text-[11px] text-muted">{st.containers.length} çalışan container</div>
      </Card>
    </div>
  )
}

function PostcheckView({ r, allow, disabled, onAutoremove }: { r: PostcheckResult; allow: boolean; disabled: boolean; onAutoremove: () => void }): ReactNode {
  return (
    <Card>
      <SectionTitle
        right={
          <Button small disabled={disabled || !allow} onClick={onAutoremove} title="sudo apt-get -y autoremove: eski çekirdekleri temizler">
            Eski çekirdekleri temizle (autoremove)
          </Button>
        }
      >
        Reboot sonrası kontrol {r.ok ? '✓' : '✕'}
      </SectionTitle>
      <div className="mb-2 text-[12px]">
        Çekirdek: <span className="font-mono">{r.kernel ?? '—'}</span>{' '}
        {r.expectedKernel ? (r.kernelOk ? <span className="text-good">✓ beklenen</span> : <span className="text-critical">✕ beklenen {r.expectedKernel}</span>) : null}
        {' · '}reboot-required: {r.rebootRequired ? <span className="text-critical">hâlâ var</span> : <span className="text-good">yok</span>}
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

function LiveLog({ lines }: { lines: LogLine[] }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length])
  return (
    <Card>
      <SectionTitle>Canlı çıktı</SectionTitle>
      <pre ref={ref} className="tnum m-0 h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
        {lines.length === 0 ? <span className="text-muted">Henüz çıktı yok.</span> : null}
        {lines.map((l, i) => (
          <div key={i} className={/^✕|\b(E:|error|failed)\b/i.test(l.text) ? 'text-critical' : /^✓/.test(l.text) ? 'text-good' : /^(▶|═)|^W:|⚠/.test(l.text) ? 'text-ink' : ''}>
            <span className="text-muted">[{STEP_LABEL[l.step]}] </span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
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
