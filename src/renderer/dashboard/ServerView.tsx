import { useState, type ReactNode } from 'react'
import type { AppSnapshot, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { CONN_LABEL, containerInfoSeverity, rootDisk, serverSeverity } from '../lib/health'
import { ago, fmtBytes, fmtMs, fmtPct, fmtUptime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { Alert, Button, Card, Empty, SectionTitle, Stat, StatusDot } from '../components/ui'
import { HostCharts } from './HostCharts'
import { ProjectCard } from './ProjectCard'
import { LogViewer, type LogTarget } from './LogViewer'
import { MaintenanceTab } from './MaintenanceTab'
import type { Nav } from './App'

type Tab = 'projects' | 'containers' | 'units' | 'docker' | 'maint'

export function ServerView({ snap, server, nav }: { snap: AppSnapshot; server: ServerConfig; nav: Nav }): ReactNode {
  const st = snap.states[server.id]
  const h = st?.host
  const sev = serverSeverity(server, st, snap.issues)
  const issues = snap.issues.filter((i) => i.serverId === server.id)
  const projects = snap.projects.filter((p) => p.serverId === server.id)
  const [tab, setTab] = useState<Tab>('projects')
  const [logs, setLogs] = useState<LogTarget | null>(null)
  const now = useNow()
  const disk = rootDisk(st)
  const errors = Object.entries(st?.errors ?? {})

  return (
    <div className="flex flex-col gap-5">
      {/* Başlık */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot sev={sev} size={22} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{server.name}</h1>
          <div className="text-[12px] text-ink-2">
            {server.username}@{server.host}:{server.port} · {CONN_LABEL[st?.connection ?? 'idle']}
            {st?.reach?.sshMs != null ? ` · SSH ${fmtMs(st.reach.sshMs)}` : ''}
            {h?.uptimeSec != null ? ` · çalışma süresi ${fmtUptime(h.uptimeSec)}` : ''}
            {h ? ` · güncellendi ${ago(h.ts, now)}` : ''}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => void api.invoke('server:reconnect', server.id)} title="SSH bağlantısını yeniden kur">
            ↻ Yeniden bağlan
          </Button>
          <Button onClick={() => nav({ view: 'discover', serverId: server.id })}>🔍 Keşfet</Button>
          <Button onClick={() => nav({ view: 'editServer', serverId: server.id })}>Düzenle</Button>
        </div>
      </div>

      {st?.connection === 'hostkey-mismatch' ? (
        <Alert kind="error">
          Sunucunun host key parmak izi kayıtlı olanla eşleşmiyor. Bu bir ortadaki adam saldırısı olabilir. Sunucu yeniden kurulduysa “Düzenle” ekranından parmak izini yeniden onaylayın.
        </Alert>
      ) : st?.connection === 'error' && st.connError ? (
        <Alert kind="error">SSH: {st.connError}</Alert>
      ) : null}

      {issues.length ? (
        <Card>
          <SectionTitle>Açık sorunlar ({issues.length})</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {issues.map((i) => (
              <li key={i.key} className="flex items-start gap-2 text-[13px]">
                <StatusDot sev={i.severity} size={14} />
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{i.title}</span>
                  {i.detail ? <span className="text-ink-2"> · {i.detail}</span> : null}
                </div>
                <span className="shrink-0 text-[11px] text-muted">{ago(i.since, now)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Anlık metrikler */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="CPU" value={fmtPct(h?.cpuPct, 1)} sub={h?.cores ? `${h.cores} çekirdek` : undefined} />
        <Stat label="RAM" value={fmtPct(h?.memPct, 1)} sub={h?.memTotal ? `${fmtBytes(h.memUsed)} / ${fmtBytes(h.memTotal)}` : undefined} />
        <Stat label="Swap" value={h?.swapTotal ? fmtPct(((h.swapUsed ?? 0) / h.swapTotal) * 100) : '—'} sub={h?.swapTotal ? `${fmtBytes(h.swapUsed)} / ${fmtBytes(h.swapTotal)}` : 'yok'} />
        <Stat label="Load" value={h?.load ? h.load[0].toFixed(2) : '—'} sub={h?.load ? `5 dk ${h.load[1].toFixed(2)} · 15 dk ${h.load[2].toFixed(2)}` : undefined} />
        <Stat label="Disk (/)" value={fmtPct(disk?.pct)} sub={disk ? `${fmtBytes(disk.avail)} boş` : undefined} />
      </div>

      <HostCharts server={server} current={{ cpu: h?.cpuPct ?? null, mem: h?.memPct ?? null, disk: disk?.pct ?? null }} />

      {/* Sekmeler */}
      <div>
        <div className="mb-3 flex gap-1 border-b border-line">
          {(
            [
              ['projects', `Projeler (${projects.length})`],
              ['containers', `Container’lar (${st?.docker?.containers.length ?? 0})`],
              ['units', 'Servisler'],
              ['docker', 'Disk & Docker'],
              ['maint', st?.maintenance ? 'Bakım ●' : 'Bakım']
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === k ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'projects' ? (
          projects.length ? (
            <>
            <div className="mb-3 flex justify-end">
              <Button small onClick={() => nav({ view: 'editProject', serverId: server.id })}>
                + Proje ekle
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  st={st}
                  onOpen={() => nav({ view: 'project', serverId: server.id, projectId: p.id })}
                  onLogs={(name) => setLogs({ serverId: server.id, kind: 'container', name })}
                />
              ))}
            </div>
            </>
          ) : (
            <Empty>
              Henüz proje yok. <button className="text-accent" onClick={() => nav({ view: 'discover', serverId: server.id })}>Keşfet</button> ile sunucudaki projeleri otomatik bulabilir ya da{' '}
              <button className="text-accent" onClick={() => nav({ view: 'editProject', serverId: server.id })}>
                elle ekleyebilirsiniz
              </button>
              .
            </Empty>
          )
        ) : null}

        {tab === 'containers' ? <ContainersTab snap={snap} server={server} onLogs={setLogs} /> : null}
        {tab === 'units' ? <UnitsTab snap={snap} server={server} onLogs={setLogs} /> : null}
        {tab === 'docker' ? <DockerTab snap={snap} server={server} /> : null}
        {tab === 'maint' ? <MaintenanceTab snap={snap} server={server} /> : null}
      </div>

      {errors.length ? (
        <details className="text-[12px] text-ink-2">
          <summary className="cursor-pointer">Toplayıcı hataları ({errors.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {errors.map(([k, v]) => (
              <li key={k}>
                <b>{k}</b>: {v}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {logs ? <LogViewer target={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  )
}

function ContainersTab({ snap, server, onLogs }: { snap: AppSnapshot; server: ServerConfig; onLogs: (t: LogTarget) => void }): ReactNode {
  const st = snap.states[server.id]
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  if (!st?.docker) return <Empty>Docker verisi henüz alınmadı.</Empty>
  if (!st.docker.available) return <Alert kind="warn">{st.docker.error}</Alert>

  const restart = async (name: string): Promise<void> => {
    setBusy(name)
    setMsg(null)
    const r = await api.invoke('action:restartContainer', server.id, name)
    setBusy(null)
    if (r.cancelled) return
    setMsg(r.ok ? { kind: 'ok', text: `${name} yeniden başlatıldı` } : { kind: 'error', text: r.error ?? r.output ?? 'Hata' })
  }

  const rows = [...st.docker.containers].sort((a, b) => (a.composeProject ?? '~').localeCompare(b.composeProject ?? '~') || a.name.localeCompare(b.name))
  return (
    <div className="flex flex-col gap-2">
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-[12px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Container</th>
              <th className="px-3 py-2 font-medium">Compose</th>
              <th className="px-3 py-2 font-medium">Durum</th>
              <th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">RAM</th>
              <th className="px-3 py-2 text-right font-medium">Restart</th>
              <th className="px-3 py-2 font-medium">Portlar</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <StatusDot sev={containerInfoSeverity(c)} size={12} />
                    <span className="font-medium">{c.name}</span>
                  </span>
                  <div className="truncate pl-5 text-[10px] text-muted" title={c.image}>
                    {c.image}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-ink-2">{c.composeProject ?? '—'}</td>
                <td className="px-3 py-1.5 text-ink-2">{c.status}</td>
                <td className="px-3 py-1.5 text-right">{fmtPct(c.cpuPct, 1)}</td>
                <td className="px-3 py-1.5 text-right">{fmtBytes(c.memBytes)}</td>
                <td className={`px-3 py-1.5 text-right ${c.lastRestartIncreaseAt ? 'font-semibold text-warning' : ''}`}>{c.restartCount ?? '—'}</td>
                <td className="max-w-[200px] truncate px-3 py-1.5 text-[11px] text-ink-2" title={c.ports}>
                  {c.ports || '—'}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <Button small variant="ghost" onClick={() => onLogs({ serverId: server.id, kind: 'container', name: c.name })}>
                    Log
                  </Button>
                  {snap.settings.allowActions ? (
                    <Button small variant="danger" disabled={busy === c.name} onClick={() => void restart(c.name)}>
                      {busy === c.name ? '…' : 'Restart'}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function UnitsTab({ snap, server, onLogs }: { snap: AppSnapshot; server: ServerConfig; onLogs: (t: LogTarget) => void }): ReactNode {
  const st = snap.states[server.id]
  if (!st?.systemd) return <Empty>systemd verisi henüz alınmadı.</Empty>
  return (
    <div className="flex flex-col gap-3">
      {st.systemd.units.length === 0 ? (
        <Empty>
          İzlenen servis yok. <b>Düzenle</b> ekranından ya da keşif ile ekleyebilirsiniz.
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {st.systemd.units.map((u) => (
            <div key={u.name} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
              <StatusDot sev={u.state === 'active' ? 'ok' : u.state === 'activating' || u.state === 'reloading' ? 'warn' : u.state === 'unknown' ? 'unknown' : 'crit'} size={14} />
              <span className="font-medium">{u.name}</span>
              <span className="text-[11px] text-ink-2">{u.state}</span>
              <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => onLogs({ serverId: server.id, kind: 'unit', name: u.name })}>
                log
              </button>
            </div>
          ))}
        </div>
      )}
      {st.systemd.failed.length ? (
        <Alert kind="warn">
          <b>systemctl --failed:</b> {st.systemd.failed.join(', ')}
        </Alert>
      ) : (
        <div className="text-[12px] text-ink-2">Başarısız unit yok.</div>
      )}
    </div>
  )
}

function DockerTab({ snap, server }: { snap: AppSnapshot; server: ServerConfig }): ReactNode {
  const st = snap.states[server.id]
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card>
        <SectionTitle>Dosya sistemleri</SectionTitle>
        <table className="tnum w-full text-[12px]">
          <tbody>
            {(st?.host?.disks ?? []).map((d) => (
              <tr key={d.mount} className="border-t border-line">
                <td className="py-1.5 font-medium">{d.mount}</td>
                <td className="py-1.5 text-ink-2">{d.fs}</td>
                <td className="py-1.5 text-right">
                  {fmtBytes(d.used)} / {fmtBytes(d.size)}
                </td>
                <td className={`py-1.5 text-right font-semibold ${d.pct >= snap.settings.thresholds.diskPct ? 'text-critical' : ''}`}>%{d.pct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <SectionTitle>docker system df</SectionTitle>
        {st?.dockerMeta?.error ? <Alert kind="warn">{st.dockerMeta.error}</Alert> : null}
        <table className="tnum w-full text-[12px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="py-1 font-medium">Tür</th>
              <th className="py-1 text-right font-medium">Toplam</th>
              <th className="py-1 text-right font-medium">Aktif</th>
              <th className="py-1 text-right font-medium">Boyut</th>
              <th className="py-1 text-right font-medium">Geri kazanılabilir</th>
            </tr>
          </thead>
          <tbody>
            {(st?.dockerMeta?.df ?? []).map((r) => (
              <tr key={r.type} className="border-t border-line">
                <td className="py-1.5 font-medium">{r.type}</td>
                <td className="py-1.5 text-right">{r.total}</td>
                <td className="py-1.5 text-right">{r.active}</td>
                <td className="py-1.5 text-right">{r.size}</td>
                <td className="py-1.5 text-right text-ink-2">{r.reclaimable}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!st?.dockerMeta ? <div className="text-[12px] text-muted">5 dakikada bir güncellenir.</div> : null}
      </Card>
    </div>
  )
}
