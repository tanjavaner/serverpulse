import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { AppSnapshot, ServerConfig } from '@shared/types'
import { api, useSnapshot, useTheme } from '../lib/api'
import { useNow } from '../lib/hooks'
import { CONN_LABEL, containerCounts, rootDisk, serverSeverity, sevRank, SEV_LABEL } from '../lib/health'
import { fmtBytes, fmtMs } from '../lib/format'
import { MiniBar, StatusDot } from '../components/ui'

export function Widget(): ReactNode {
  const snap = useSnapshot()
  useTheme(snap?.settings.theme)
  const rootRef = useRef<HTMLDivElement>(null)

  // İçerik yüksekliğini main process'e bildir; pencere sağ altta büyür/küçülür
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => void api.invoke('window:widgetHeight', Math.ceil(el.getBoundingClientRect().height) + 2))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={rootRef} className="overflow-hidden rounded-xl border border-line bg-surface/95 text-ink shadow-xl backdrop-blur">
      <Header snap={snap} />
      {!snap ? (
        <div className="p-4 text-ink-2">Yükleniyor…</div>
      ) : snap.servers.length === 0 ? (
        <button className="w-full p-4 text-left text-ink-2 hover:bg-surface-2" onClick={() => void api.invoke('window:openDashboard')}>
          Henüz sunucu eklenmedi. <span className="text-accent">Dashboard’dan ekleyin →</span>
        </button>
      ) : (
        <ServerRows snap={snap} />
      )}
    </div>
  )
}

function Header({ snap }: { snap: AppSnapshot | null }): ReactNode {
  const overall = snap?.overall ?? 'unknown'
  return (
    <div className="drag flex items-center gap-2 border-b border-line px-3 py-2">
      <StatusDot sev={overall} size={12} />
      <span className="text-[12px] font-semibold">ServerPulse</span>
      <span className="text-[11px] text-muted">{SEV_LABEL[overall]}</span>
      <div className="no-drag ml-auto flex items-center gap-0.5">
        <IconBtn title="Şimdi yenile" onClick={() => void api.invoke('app:refresh')}>
          ↻
        </IconBtn>
        <IconBtn title="Dashboard’u aç" onClick={() => void api.invoke('window:openDashboard')}>
          ⤢
        </IconBtn>
        <IconBtn title="Gizle (tray’den tekrar açılır)" onClick={() => void api.invoke('window:hideWidget')}>
          ✕
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({ children, title, onClick }: { children: ReactNode; title: string; onClick: () => void }): ReactNode {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="flex h-6 w-6 items-center justify-center rounded text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
      {children}
    </button>
  )
}

function ServerRows({ snap }: { snap: AppSnapshot }): ReactNode {
  // Kırmızı öğeler en üstte
  const rows = snap.servers
    .map((s) => ({ s, sev: serverSeverity(s, snap.states[s.id], snap.issues) }))
    .sort((a, b) => sevRank(b.sev) - sevRank(a.sev) || a.s.name.localeCompare(b.s.name))
  // Sınır pencereye (vh) değil ekrana göre: pencere içeriğe göre büyüdüğü için vh kendi kendini kısıtlardı.
  // Ekrana sığmayacak kadar çok sunucu varsa liste kaydırılır.
  const maxListPx = Math.max(200, window.screen.availHeight - 120)
  return (
    <div className="divide-y divide-[var(--border)] overflow-y-auto" style={{ maxHeight: maxListPx }}>
      {rows.map(({ s, sev }) => (
        <ServerRow key={s.id} server={s} snap={snap} sev={sev} />
      ))}
    </div>
  )
}

function ServerRow({ server, snap, sev }: { server: ServerConfig; snap: AppSnapshot; sev: ReturnType<typeof serverSeverity> }): ReactNode {
  const st = snap.states[server.id]
  const h = st?.host
  const th = snap.settings.thresholds
  const disk = rootDisk(st)
  const counts = containerCounts(st, snap, server.id)
  const issues = snap.issues.filter((i) => i.serverId === server.id)
  const calls = st?.asterisk?.mode === 'full' ? st.asterisk.activeCalls : null
  const now = useNow()
  const stale = h && now - h.ts > Math.max(30_000, snap.settings.intervals.fastSec * 4000)

  return (
    <button className="block w-full px-3 py-2.5 text-left hover:bg-surface-2" onClick={() => void api.invoke('window:openDashboard', server.id)} title="Detay için tıklayın">
      <div className="mb-1.5 flex items-center gap-2">
        <StatusDot sev={sev} size={14} />
        <span className="truncate text-[13px] font-semibold">{server.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {st?.connection === 'ready' ? (st.reach?.sshMs != null ? fmtMs(st.reach.sshMs) : CONN_LABEL.ready) : CONN_LABEL[st?.connection ?? 'idle']}
          {stale ? ' · eski veri' : ''}
        </span>
      </div>
      {st?.connection === 'ready' || h ? (
        <div className="flex flex-col gap-1">
          <MiniBar label="CPU" pct={h?.cpuPct ?? null} warnAt={80} critAt={95} />
          <MiniBar label="RAM" pct={h?.memPct ?? null} warnAt={th.ramPct - 10} critAt={th.ramPct} />
          <MiniBar label="Disk" pct={disk?.pct ?? null} warnAt={th.diskPct} critAt={95} suffix={disk ? fmtBytes(disk.avail) : undefined} />
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-2">
        {counts ? (
          <span>
            <b className={counts.healthy === counts.total ? 'text-ink' : 'text-critical'}>
              {counts.healthy}/{counts.total}
            </b>{' '}
            container sağlıklı
          </span>
        ) : st?.docker && !st.docker.available ? (
          <span className="text-warning">Docker okunamıyor</span>
        ) : null}
        {calls != null ? (
          <span>
            📞 <b className="text-ink">{calls}</b> aktif çağrı
          </span>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {issues.slice(0, 4).map((i) => (
            <li key={i.key} className="flex items-center gap-1.5 text-[11px]">
              <StatusDot sev={i.severity} size={10} />
              <span className="truncate">{i.title}</span>
            </li>
          ))}
          {issues.length > 4 ? <li className="text-[11px] text-muted">+{issues.length - 4} sorun daha</li> : null}
        </ul>
      ) : null}
    </button>
  )
}
