import { useMemo, useState, type ReactNode } from 'react'
import type { PromPreset, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { fmtBytes, fmtPct } from '../lib/format'
import { downsample, MultiLine, SparkArea, type Point } from '../components/charts'
import { Alert } from '../components/ui'

const RANGES = [
  { h: 1, label: '1 sa' },
  { h: 6, label: '6 sa' },
  { h: 24, label: '24 sa' },
  { h: 72, label: '72 sa' }
]
const PROM_RANGES = [
  { h: 24, label: '24 sa' },
  { h: 168, label: '7 gün' },
  { h: 720, label: '30 gün' }
]

export function RangePicker({ value, options, onChange }: { value: number; options: { h: number; label: string }[]; onChange: (h: number) => void }): ReactNode {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((r) => (
        <button
          key={r.h}
          onClick={() => onChange(r.h)}
          className={`rounded px-2 py-0.5 text-xs ${value === r.h ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

/** CPU / RAM / Disk: aynı ölçekte olsalar da ayrı küçük grafikler (small multiples). */
export function HostCharts({ server, current }: { server: ServerConfig; current: { cpu: number | null; mem: number | null; disk: number | null } }): ReactNode {
  const [source, setSource] = useState<'local' | 'prom'>('local')
  const [hours, setHours] = useState(24)
  const [promHours, setPromHours] = useState(168)

  const { data } = useAsync(() => api.invoke('history:host', server.id, Date.now() - hours * 3600_000), [server.id, hours], 60_000)
  const points: Point[] = useMemo(() => downsample((data ?? []).map((r) => ({ ts: r.ts, cpu: r.cpu, mem: r.mem, disk: r.disk }))), [data])

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Geçmiş</h3>
        <div className="flex items-center gap-2">
          {server.prometheus ? (
            <RangePicker
              value={source === 'local' ? 0 : 1}
              options={[
                { h: 0, label: 'Yerel' },
                { h: 1, label: 'Prometheus' }
              ]}
              onChange={(v) => setSource(v === 0 ? 'local' : 'prom')}
            />
          ) : null}
          {source === 'local' ? <RangePicker value={hours} options={RANGES} onChange={setHours} /> : <RangePicker value={promHours} options={PROM_RANGES} onChange={setPromHours} />}
        </div>
      </div>
      {source === 'local' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <SparkArea title="CPU" data={points} dataKey="cpu" color="var(--s1)" current={fmtPct(current.cpu, 1)} />
          <SparkArea title="RAM" data={points} dataKey="mem" color="var(--s1)" current={fmtPct(current.mem, 1)} />
          <SparkArea title="Disk (/)" data={points} dataKey="disk" color="var(--s1)" current={fmtPct(current.disk)} />
        </div>
      ) : (
        <PromCharts serverId={server.id} hours={promHours} />
      )}
    </div>
  )
}

function PromCharts({ serverId, hours }: { serverId: string; hours: number }): ReactNode {
  const q = (p: PromPreset) => api.invoke('prometheus:query', serverId, p, hours)
  const cpu = useAsync(() => q('cpu'), [serverId, hours])
  const mem = useAsync(() => q('mem'), [serverId, hours])
  const disk = useAsync(() => q('disk'), [serverId, hours])
  const net = useAsync(() => q('net'), [serverId, hours])
  const toPoints = (r: typeof cpu.data): Point[] => (r?.series[0]?.points ?? []).map((p) => ({ ts: p.ts, v: p.value }))
  const err = [cpu, mem, disk, net].map((x) => x.data?.error).find(Boolean)

  const netData = useMemo(() => {
    const series = (net.data?.series ?? []).slice(0, 8)
    const map = new Map<number, Point>()
    series.forEach((s, i) => {
      for (const p of s.points) {
        const row = map.get(p.ts) ?? { ts: p.ts }
        row[`n${i}`] = p.value
        map.set(p.ts, row)
      }
    })
    return { rows: [...map.values()].sort((a, b) => a.ts - b.ts), series: series.map((s, i) => ({ key: `n${i}`, label: s.label })) }
  }, [net.data])

  if (cpu.loading && !cpu.data) return <div className="text-xs text-muted">Prometheus sorgulanıyor…</div>
  return (
    <div className="flex flex-col gap-3">
      {err ? <Alert kind="warn">Prometheus: {err}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SparkArea title="CPU" data={toPoints(cpu.data)} dataKey="v" />
        <SparkArea title="RAM" data={toPoints(mem.data)} dataKey="v" />
        <SparkArea title="Disk (/)" data={toPoints(disk.data)} dataKey="v" />
      </div>
      <MultiLine title="Ağ (gelen, B/s)" data={netData.rows} series={netData.series} format={(v) => `${fmtBytes(v)}/s`} height={180} />
    </div>
  )
}
