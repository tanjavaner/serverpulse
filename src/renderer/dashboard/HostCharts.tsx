import { useMemo, useState, type ReactNode } from 'react'
import type { PromPreset, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { fmtBytes, fmtPct } from '../lib/format'
import { downsample, MultiLine, SparkArea, type Point } from '../components/charts'
import { Alert } from '../components/ui'

/** Etiketler dil değişince yeniden üretilsin diye fonksiyon. */
export function hourRanges(): { h: number; label: string }[] {
  return [1, 6, 24, 72].map((h) => ({ h, label: t('range.hours', { n: h }) }))
}
function promRanges(): { h: number; label: string }[] {
  return [
    { h: 24, label: t('range.hours', { n: 24 }) },
    { h: 168, label: t('range.days', { n: 7 }) },
    { h: 720, label: t('range.days', { n: 30 }) }
  ]
}

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

/** Yerel geçmiş aralıkları: 72 saate kadar ham örnekler, 7/30 gün 5 dakikalık özetler. */
function localRanges(): { h: number; label: string }[] {
  return [...hourRanges(), { h: 168, label: t('range.days', { n: 7 }) }, { h: 720, label: t('range.days', { n: 30 }) }]
}
const RAW_MAX_HOURS = 72

/** CPU / RAM / Disk: aynı ölçekte olsalar da ayrı küçük grafikler (small multiples); altında ağ trafiği. */
export function HostCharts({ server, current }: { server: ServerConfig; current: { cpu: number | null; mem: number | null; disk: number | null } }): ReactNode {
  const [source, setSource] = useState<'local' | 'prom'>('local')
  const [hours, setHours] = useState(24)
  const [promHours, setPromHours] = useState(168)

  const { data } = useAsync(
    () => api.invoke(hours > RAW_MAX_HOURS ? 'history:hostRollup' : 'history:host', server.id, Date.now() - hours * 3600_000),
    [server.id, hours],
    60_000
  )
  const points: Point[] = useMemo(() => downsample((data ?? []).map((r) => ({ ts: r.ts, cpu: r.cpu, mem: r.mem, disk: r.disk, rx: r.rx, tx: r.tx }))), [data])
  const hasNet = points.some((p) => p.rx != null)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('common.history')}</h3>
        <div className="flex items-center gap-2">
          {server.prometheus ? (
            <RangePicker
              value={source === 'local' ? 0 : 1}
              options={[
                { h: 0, label: t('hist.local') },
                { h: 1, label: 'Prometheus' }
              ]}
              onChange={(v) => setSource(v === 0 ? 'local' : 'prom')}
            />
          ) : null}
          {source === 'local' ? <RangePicker value={hours} options={localRanges()} onChange={setHours} /> : <RangePicker value={promHours} options={promRanges()} onChange={setPromHours} />}
        </div>
      </div>
      {source === 'local' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <SparkArea title="CPU" data={points} dataKey="cpu" color="var(--s1)" current={fmtPct(current.cpu, 1)} />
          <SparkArea title="RAM" data={points} dataKey="mem" color="var(--s1)" current={fmtPct(current.mem, 1)} />
          <SparkArea title="Disk (/)" data={points} dataKey="disk" color="var(--s1)" current={fmtPct(current.disk)} />
          {hasNet ? (
            <div className="md:col-span-3">
              <MultiLine
                title={t('hist.net')}
                data={points}
                series={[
                  { key: 'rx', label: t('hist.netRx') },
                  { key: 'tx', label: t('hist.netTx') }
                ]}
                format={(v) => `${fmtBytes(v)}/s`}
                height={160}
              />
            </div>
          ) : null}
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

  if (cpu.loading && !cpu.data) return <div className="text-xs text-muted">{t('hist.promLoading')}</div>
  return (
    <div className="flex flex-col gap-3">
      {err ? <Alert kind="warn">Prometheus: {err}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SparkArea title="CPU" data={toPoints(cpu.data)} dataKey="v" />
        <SparkArea title="RAM" data={toPoints(mem.data)} dataKey="v" />
        <SparkArea title="Disk (/)" data={toPoints(disk.data)} dataKey="v" />
      </div>
      <MultiLine title={t('hist.netIn')} data={netData.rows} series={netData.series} format={(v) => `${fmtBytes(v)}/s`} height={180} />
    </div>
  )
}
