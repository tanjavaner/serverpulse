import { useState, type ReactNode } from 'react'
import type { AppSnapshot, ContainerAction, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { connLabel, containerInfoSeverity, rootDisk, serverSeverity } from '../lib/health'
import { ago, fmtBytes, fmtMs, fmtPct, fmtUptime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { Alert, Button, Card, Empty, SectionTitle, Stat, StatusDot } from '../components/ui'
import { HostCharts } from './HostCharts'
import { ProjectCard } from './ProjectCard'
import { LogViewer, type LogTarget } from './LogViewer'
import { MaintenanceTab } from './MaintenanceTab'
import { IssueMute, ServerMute } from './Mute'
import { TerminalTab } from './TerminalTab'
import { ProcessesCard, SecurityTab } from './Insights'
import type { Nav } from './App'

type Tab = 'projects' | 'containers' | 'units' | 'docker' | 'security' | 'maint' | 'terminal'

export function ServerView({ snap, server, nav }: { snap: AppSnapshot; server: ServerConfig; nav: Nav }): ReactNode {
  const st = snap.states[server.id]
  const h = st?.host
  const sev = serverSeverity(server, st, snap.issues)
  const issues = snap.issues.filter((i) => i.serverId === server.id)
  const projects = snap.projects.filter((p) => p.serverId === server.id)
  const [tab, setTab] = useState<Tab>('projects')
  const [logs, setLogs] = useState<LogTarget | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  /** Bu sunucunun proje tanımlarını siler ve keşfi baştan çalıştırır (sunucuda hiçbir şey değişmez). */
  const resetProjects = async (): Promise<void> => {
    await api.invoke('projects:save', server.id, [])
    setConfirmReset(false)
    nav({ view: 'discover', serverId: server.id })
  }
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
            {server.username}@{server.host}:{server.port} · {connLabel(st?.connection ?? 'idle')}
            {st?.reach?.sshMs != null ? ` · SSH ${fmtMs(st.reach.sshMs)}` : ''}
            {h?.uptimeSec != null ? t('server.uptime', { v: fmtUptime(h.uptimeSec) }) : ''}
            {h ? t('server.updated', { v: ago(h.ts, now) }) : ''}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <ServerMute serverId={server.id} mutes={snap.mutes} />
          <Button onClick={() => void api.invoke('server:reconnect', server.id)} title={t('server.reconnectTitle')}>
            {t('server.reconnect')}
          </Button>
          <Button onClick={() => nav({ view: 'discover', serverId: server.id })}>{t('server.discover')}</Button>
          <Button onClick={() => nav({ view: 'editServer', serverId: server.id })}>{t('common.edit')}</Button>
        </div>
      </div>

      {st?.connection === 'hostkey-mismatch' ? (
        <Alert kind="error">
          {t('server.hostkeyMismatch')}
        </Alert>
      ) : st?.connection === 'auth-failed' ? (
        <Alert kind="error">
          <div className="font-semibold">{t('server.authFailedTitle')}</div>
          <div>{t('server.authFailedBody')}</div>
          {st.connError ? <div className="mt-1 text-ink-2">{st.connError}</div> : null}
          <div className="mt-2 flex gap-2">
            <Button small variant="primary" onClick={() => nav({ view: 'editServer', serverId: server.id })}>
              {t('server.updateCreds')}
            </Button>
            <Button small onClick={() => void api.invoke('server:reconnect', server.id)}>
              {t('server.retry')}
            </Button>
          </div>
        </Alert>
      ) : st?.connection === 'error' && st.connError ? (
        <Alert kind="error">{t('server.sshError', { e: st.connError })}</Alert>
      ) : null}

      {issues.length ? (
        <Card>
          <SectionTitle>{t('server.openIssues', { n: issues.length })}</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {issues.map((i) => (
              <li key={i.key} className="flex items-start gap-2 text-[13px]">
                <StatusDot sev={i.severity} size={14} />
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{i.title}</span>
                  {i.detail ? <span className="text-ink-2"> · {i.detail}</span> : null}
                </div>
                <IssueMute issueKey={i.key} mutes={snap.mutes} />
                <span className="shrink-0 text-[11px] text-muted">{ago(i.since, now)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Anlık metrikler */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="CPU" value={fmtPct(h?.cpuPct, 1)} sub={h?.cores ? t('server.cores', { n: h.cores }) : undefined} />
        <Stat label="RAM" value={fmtPct(h?.memPct, 1)} sub={h?.memTotal ? `${fmtBytes(h.memUsed)} / ${fmtBytes(h.memTotal)}` : undefined} />
        <Stat label="Swap" value={h?.swapTotal ? fmtPct(((h.swapUsed ?? 0) / h.swapTotal) * 100) : '—'} sub={h?.swapTotal ? `${fmtBytes(h.swapUsed)} / ${fmtBytes(h.swapTotal)}` : t('common.none')} />
        <Stat label="Load" value={h?.load ? h.load[0].toFixed(2) : '—'} sub={h?.load ? t('server.load515', { a: h.load[1].toFixed(2), b: h.load[2].toFixed(2) }) : undefined} />
        <Stat label="Disk (/)" value={fmtPct(disk?.pct)} sub={disk ? t('server.free', { v: fmtBytes(disk.avail) }) : undefined} />
        <Stat
          label={t('server.net')}
          value={h?.netRx != null ? `${fmtBytes((h.netRx ?? 0) + (h.netTx ?? 0))}/s` : '—'}
          sub={h?.netRx != null ? t('server.netSub', { rx: fmtBytes(h.netRx), tx: fmtBytes(h.netTx) }) : undefined}
        />
      </div>

      <HostCharts server={server} current={{ cpu: h?.cpuPct ?? null, mem: h?.memPct ?? null, disk: disk?.pct ?? null }} />
      <ProcessesCard server={server} />

      {/* Sekmeler */}
      <div>
        <div className="mb-3 flex gap-1 border-b border-line">
          {(
            [
              ['projects', t('server.tabProjects', { n: projects.length })],
              ['containers', t('server.tabContainers', { n: st?.docker?.containers.length ?? 0 })],
              ['units', t('server.tabUnits')],
              ['docker', t('server.tabDocker')],
              ['security', t('server.tabSecurity')],
              ['maint', st?.maintenance ? `${t('server.tabMaint')} ●` : t('server.tabMaint')],
              ...(snap.settings.allowTerminal ? [['terminal', t('server.tabTerminal')]] : [])
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
            <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
              {confirmReset ? (
                <>
                  <span className="text-[12px] text-ink-2">{t('server.resetConfirm', { n: projects.length })}</span>
                  <Button small variant="danger" onClick={() => void resetProjects()}>
                    {t('server.resetYes')}
                  </Button>
                  <Button small variant="ghost" onClick={() => setConfirmReset(false)}>
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <Button small variant="ghost" onClick={() => setConfirmReset(true)}>
                  {t('server.resetProjects')}
                </Button>
              )}
              <Button small onClick={() => nav({ view: 'editProject', serverId: server.id })}>
                {t('server.addProject')}
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
              {t('server.noProjects')}{' '}
              <button className="text-accent" onClick={() => nav({ view: 'discover', serverId: server.id })}>
                {t('server.noProjectsDiscover')}
              </button>
              {t('server.noProjectsMiddle')}
              <button className="text-accent" onClick={() => nav({ view: 'editProject', serverId: server.id })}>
                {t('server.noProjectsManual')}
              </button>
              .
            </Empty>
          )
        ) : null}

        {tab === 'containers' ? <ContainersTab snap={snap} server={server} onLogs={setLogs} /> : null}
        {tab === 'units' ? <UnitsTab snap={snap} server={server} onLogs={setLogs} /> : null}
        {tab === 'docker' ? <DockerTab snap={snap} server={server} /> : null}
        {tab === 'security' ? <SecurityTab snap={snap} server={server} /> : null}
        {tab === 'maint' ? <MaintenanceTab snap={snap} server={server} /> : null}
        {tab === 'terminal' && snap.settings.allowTerminal ? <TerminalTab server={server} /> : null}
      </div>

      {errors.length ? (
        <details className="text-[12px] text-ink-2">
          <summary className="cursor-pointer">{t('server.collectorErrors', { n: errors.length })}</summary>
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
  if (!st?.docker) return <Empty>{t('ctr.noData')}</Empty>
  if (!st.docker.available) return <Alert kind="warn">{st.docker.error}</Alert>

  const run = async (name: string, action: ContainerAction): Promise<void> => {
    setBusy(name)
    setMsg(null)
    const r = await api.invoke('action:container', server.id, name, action)
    setBusy(null)
    if (r.cancelled) return
    const done = { start: t('ctr.started', { name }), stop: t('ctr.stopped', { name }), restart: t('ctr.restarted', { name }) }[action]
    setMsg(r.ok ? { kind: 'ok', text: done } : { kind: 'error', text: r.error ?? r.output ?? t('common.error') })
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
              <th className="px-3 py-2 font-medium">{t('ctr.colStatus')}</th>
              <th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">RAM</th>
              <th className="px-3 py-2 text-right font-medium">Restart</th>
              <th className="px-3 py-2 font-medium">{t('ctr.colPorts')}</th>
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
                    {t('ctr.log')}
                  </Button>
                  {snap.settings.allowActions ? (
                    c.state === 'running' || c.state === 'restarting' ? (
                      <>
                        <Button small variant="danger" disabled={busy === c.name} onClick={() => void run(c.name, 'restart')}>
                          {busy === c.name ? '…' : t('ctr.restart')}
                        </Button>
                        <Button small variant="danger" disabled={busy === c.name} onClick={() => void run(c.name, 'stop')}>
                          {t('ctr.stop')}
                        </Button>
                      </>
                    ) : (
                      <Button small disabled={busy === c.name} onClick={() => void run(c.name, 'start')}>
                        {busy === c.name ? '…' : t('ctr.start')}
                      </Button>
                    )
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
  if (!st?.systemd) return <Empty>{t('units.noData')}</Empty>
  return (
    <div className="flex flex-col gap-3">
      {st.systemd.units.length === 0 ? (
        <Empty>
          {t('units.none')}
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {st.systemd.units.map((u) => (
            <div key={u.name} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
              <StatusDot sev={u.state === 'active' ? 'ok' : u.state === 'activating' || u.state === 'reloading' ? 'warn' : u.state === 'unknown' ? 'unknown' : 'crit'} size={14} />
              <span className="font-medium">{u.name}</span>
              <span className="text-[11px] text-ink-2">{u.state}</span>
              <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => onLogs({ serverId: server.id, kind: 'unit', name: u.name })}>
                {t('units.log')}
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
        <div className="text-[12px] text-ink-2">{t('units.noFailed')}</div>
      )}
    </div>
  )
}

function DockerTab({ snap, server }: { snap: AppSnapshot; server: ServerConfig }): ReactNode {
  const st = snap.states[server.id]
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const prune = async (mode: 'safe' | 'images'): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await api.invoke('action:prune', server.id, mode)
    setBusy(false)
    if (!r.cancelled) setMsg(r.ok ? { kind: 'ok', text: r.output ?? '' } : { kind: 'error', text: r.error ?? t('common.error') })
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card>
        <SectionTitle>{t('dock.filesystems')}</SectionTitle>
        <table className="tnum w-full text-[12px]">
          <tbody>
            {(st?.host?.disks ?? []).map((d) => {
              const inode = st?.storage?.inodes.find((i) => i.mount === d.mount)
              const th = snap.settings.thresholds.diskPct
              return (
                <tr key={d.mount} className="border-t border-line">
                  <td className="py-1.5 font-medium">{d.mount}</td>
                  <td className="py-1.5 text-ink-2">{d.fs}</td>
                  <td className="py-1.5 text-right">
                    {fmtBytes(d.used)} / {fmtBytes(d.size)}
                  </td>
                  <td className={`py-1.5 text-right font-semibold ${d.pct >= th ? 'text-critical' : ''}`}>{fmtPct(d.pct)}</td>
                  <td className={`py-1.5 pl-2 text-right text-[11px] ${inode && inode.pct >= th ? 'font-semibold text-critical' : 'text-muted'}`}>
                    {inode ? `${t('dock.inode')} ${fmtPct(inode.pct)}` : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Card>
        <SectionTitle>docker system df</SectionTitle>
        {st?.dockerMeta?.error ? <Alert kind="warn">{st.dockerMeta.error}</Alert> : null}
        <table className="tnum w-full text-[12px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="py-1 font-medium">{t('dock.colType')}</th>
              <th className="py-1 text-right font-medium">{t('dock.colTotal')}</th>
              <th className="py-1 text-right font-medium">{t('dock.colActive')}</th>
              <th className="py-1 text-right font-medium">{t('dock.colSize')}</th>
              <th className="py-1 text-right font-medium">{t('dock.colReclaimable')}</th>
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
        {!st?.dockerMeta ? <div className="text-[12px] text-muted">{t('dock.every5m')}</div> : null}
        {st?.storage?.noLogRotation.length ? (
          <div className="mt-3">
            <Alert kind="warn">
              <div className="font-semibold">{t('dock.noRotation', { n: st.storage.noLogRotation.length })}</div>
              <div className="font-mono text-[11px]">{st.storage.noLogRotation.join(', ')}</div>
              <div className="mt-1">{t('dock.noRotationHint')}</div>
              <pre className="mt-1 rounded bg-surface p-2 font-mono text-[11px]">{'{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }'}</pre>
            </Alert>
          </div>
        ) : null}
        {snap.settings.allowActions && st?.docker?.available ? (
          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-2">
              <Button small disabled={busy} onClick={() => void prune('safe')} title={t('dock.pruneSafeTitle')}>
                {t('dock.pruneSafe')}
              </Button>
              <Button small variant="danger" disabled={busy} onClick={() => void prune('images')}>
                {t('dock.pruneImages')}
              </Button>
            </div>
            <div className="text-[11px] text-muted">{t('dock.pruneHint')}</div>
            {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
          </div>
        ) : null}
      </Card>
    </div>
  )
}
