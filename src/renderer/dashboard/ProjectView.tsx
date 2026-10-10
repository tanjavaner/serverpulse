import { useMemo, useState, type ReactNode } from 'react'
import type { AppSnapshot, ProjectConfig, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { fmtBytes, fmtMs, fmtPct } from '../lib/format'
import { downsample, MultiLine, type Point } from '../components/charts'
import { Alert, Button } from '../components/ui'
import { pushLocal, stepLabel, useMaintLog } from '../lib/maintLog'
import { cleanErr } from './ServerForm'
import { LiveLog } from './LiveLog'
import { ProjectCard } from './ProjectCard'
import { hourRanges, RangePicker } from './HostCharts'
import { LogViewer, type LogTarget } from './LogViewer'
import type { Nav } from './App'

/** Satırları (ts, anahtar, değer) → grafik noktalarına pivotlar. */
function pivot<T extends { ts: number }>(rows: T[], keyOf: (r: T) => string, valOf: (r: T) => number | null, keys: string[]): Point[] {
  const idx = new Map(keys.map((k, i) => [k, `k${i}`]))
  const map = new Map<number, Point>()
  for (const r of rows) {
    const col = idx.get(keyOf(r))
    if (!col) continue
    // Aynı turda yazılan örnekleri tek zaman noktasında topla (saniye hassasiyeti)
    const ts = Math.round(r.ts / 1000) * 1000
    const row = map.get(ts) ?? { ts }
    row[col] = valOf(r)
    map.set(ts, row)
  }
  return downsample([...map.values()].sort((a, b) => a.ts - b.ts))
}

export function ProjectView({ snap, server, project, nav }: { snap: AppSnapshot; server: ServerConfig; project: ProjectConfig; nav: Nav }): ReactNode {
  const st = snap.states[server.id]
  const [hours, setHours] = useState(24)
  const [logs, setLogs] = useState<LogTarget | null>(null)
  const since = Date.now() - hours * 3600_000
  const checkIds = project.httpChecks.map((c) => c.id)

  const http = useAsync(() => api.invoke('history:http', checkIds, since), [project.id, hours, checkIds.join(',')], 60_000)
  const ctr = useAsync(() => api.invoke('history:containers', server.id, since), [server.id, hours], 60_000)

  const httpChart = useMemo(() => {
    const checks = project.httpChecks.slice(0, 8)
    return {
      series: checks.map((c, i) => ({ key: `k${i}`, label: c.name })),
      data: pivot(http.data ?? [], (r) => r.checkId, (r) => r.ms, checks.map((c) => c.id))
    }
  }, [http.data, project.httpChecks])

  const ctrNames = project.containers.slice(0, 8)
  const cpuChart = useMemo(() => pivot(ctr.data ?? [], (r) => r.name, (r) => r.cpu, ctrNames), [ctr.data, ctrNames])
  const memChart = useMemo(() => pivot(ctr.data ?? [], (r) => r.name, (r) => r.mem, ctrNames), [ctr.data, ctrNames])
  const ctrSeries = ctrNames.map((n, i) => ({ key: `k${i}`, label: n }))

  const remove = async (): Promise<void> => {
    await api.invoke('project:remove', project.id)
    nav({ view: 'server', serverId: server.id })
  }
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deployMsg, setDeployMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const deployLog = useMaintLog(server.id).filter((l) => l.step === 'deploy')
  const running = snap.states[server.id]?.maintenance
  const deploying = running?.step === 'deploy'

  const deploy = async (): Promise<void> => {
    setDeployMsg(null)
    pushLocal(server.id, 'deploy', t('maint.started', { s: `${stepLabel('deploy')} · ${project.name}` }))
    try {
      const r = await api.invoke('maint:deploy', server.id, project.id)
      if (r.cancelled) setDeployMsg({ kind: 'warn', text: t('maint.cancelled', { s: stepLabel('deploy') }) })
      else setDeployMsg(r.ok ? { kind: 'ok', text: r.summary ?? '' } : { kind: 'error', text: t('maint.failed', { s: stepLabel('deploy'), e: r.error ?? '' }) })
    } catch (e) {
      setDeployMsg({ kind: 'error', text: cleanErr(e) })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <button className="text-[12px] text-ink-2 hover:text-accent" onClick={() => nav({ view: 'server', serverId: server.id })}>
          ← {server.name}
        </button>
        <div className="ml-auto flex gap-2">
          {snap.settings.allowActions && project.containers.length ? (
            <Button variant="primary" disabled={!!running} onClick={() => void deploy()} title={t('project.deployHint')}>
              {deploying ? t('project.deploying') : t('project.deploy')}
            </Button>
          ) : null}
          <Button onClick={() => nav({ view: 'editProject', serverId: server.id, projectId: project.id })}>{t('common.edit')}</Button>
          {confirmDelete ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>
                {t('common.yesDelete')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('project.delete')}
            </Button>
          )}
        </div>
      </div>

      {deployMsg ? <Alert kind={deployMsg.kind}>{deployMsg.text}</Alert> : null}
      {deploying || deployLog.length ? <LiveLog lines={deployLog} height="h-56" /> : null}

      <ProjectCard project={project} st={st} onLogs={(name) => setLogs({ serverId: server.id, kind: 'container', name })} />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('common.history')}</h3>
        <RangePicker value={hours} options={hourRanges()} onChange={setHours} />
      </div>
      {project.httpChecks.length ? <MultiLine title={t('project.httpLatency')} data={httpChart.data} series={httpChart.series} format={(v) => fmtMs(v)} /> : null}
      {ctrNames.length ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MultiLine title={t('project.ctrCpu')} data={cpuChart} series={ctrSeries} format={(v) => fmtPct(v, 1)} />
          <MultiLine title={t('project.ctrRam')} data={memChart} series={ctrSeries} format={(v) => fmtBytes(v)} />
        </div>
      ) : null}

      {logs ? <LogViewer target={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  )
}
