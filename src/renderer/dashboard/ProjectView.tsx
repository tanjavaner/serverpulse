import { useMemo, useState, type ReactNode } from 'react'
import type { AppSnapshot, ProjectConfig, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { fmtBytes, fmtMs } from '../lib/format'
import { downsample, MultiLine, type Point } from '../components/charts'
import { Button } from '../components/ui'
import { ProjectCard } from './ProjectCard'
import { RangePicker } from './HostCharts'
import { LogViewer, type LogTarget } from './LogViewer'
import type { Nav } from './App'

const RANGES = [
  { h: 1, label: '1 sa' },
  { h: 6, label: '6 sa' },
  { h: 24, label: '24 sa' },
  { h: 72, label: '72 sa' }
]

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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <button className="text-[12px] text-ink-2 hover:text-accent" onClick={() => nav({ view: 'server', serverId: server.id })}>
          ← {server.name}
        </button>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => nav({ view: 'editProject', serverId: server.id, projectId: project.id })}>Düzenle</Button>
          {confirmDelete ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>
                Evet, sil
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Vazgeç
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Projeyi sil
            </Button>
          )}
        </div>
      </div>

      <ProjectCard project={project} st={st} onLogs={(name) => setLogs({ serverId: server.id, kind: 'container', name })} />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Geçmiş</h3>
        <RangePicker value={hours} options={RANGES} onChange={setHours} />
      </div>
      {project.httpChecks.length ? <MultiLine title="HTTP yanıt süresi" data={httpChart.data} series={httpChart.series} format={(v) => fmtMs(v)} /> : null}
      {ctrNames.length ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MultiLine title="Container CPU %" data={cpuChart} series={ctrSeries} format={(v) => `%${v.toFixed(1)}`} />
          <MultiLine title="Container RAM" data={memChart} series={ctrSeries} format={(v) => fmtBytes(v)} />
        </div>
      ) : null}

      {logs ? <LogViewer target={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  )
}
