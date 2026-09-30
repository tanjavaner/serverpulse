import type { ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { clock, dateTime } from '../lib/format'

/** Kategorik seriler sabit sırayla atanır; asla döngüyle üretilmez (en fazla 8). */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)']

const axisProps = {
  stroke: 'var(--axis)',
  tick: { fill: 'var(--muted)', fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: 'var(--axis)' }
} as const

const tooltipStyle = {
  contentStyle: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--ink)',
    boxShadow: '0 4px 16px rgba(0,0,0,.15)'
  },
  labelStyle: { color: 'var(--ink-2)', marginBottom: 4 },
  itemStyle: { color: 'var(--ink)', padding: 0 }
}

export interface Point {
  ts: number
  [k: string]: number | null
}

/** Tek seri (ör. CPU %) küçük alan grafiği. Başlık seriyi adlandırır; lejant gerekmez. */
export function SparkArea({
  title,
  data,
  dataKey,
  color = 'var(--s1)',
  domain = [0, 100],
  format = (v: number) => `%${v.toFixed(1)}`,
  height = 140,
  current
}: {
  title: string
  data: Point[]
  dataKey: string
  color?: string
  domain?: [number, number | 'auto']
  format?: (v: number) => string
  height?: number
  current?: string
}): ReactNode {
  const gid = `g-${dataKey}-${title.replace(/\W/g, '')}`
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-ink">{title}</span>
        {current ? <span className="tnum text-xs text-ink-2">{current}</span> : null}
      </div>
      {data.length < 2 ? (
        <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
          Henüz yeterli geçmiş yok
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={clock} minTickGap={40} {...axisProps} />
            <YAxis domain={domain} width={44} tickFormatter={(v: number) => format(v).replace(/\.0(?=\D|$)/, '')} {...axisProps} />
            <Tooltip
              {...tooltipStyle}
              labelFormatter={(v) => dateTime(Number(v))}
              formatter={(v) => [typeof v === 'number' ? format(v) : '—', title]}
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gid})`}
              isAnimationActive={false}
              connectNulls={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Çok serili çizgi grafiği (tek eksen). Seri sayısı 8'i geçerse çağıran taraf kırpar. */
export function MultiLine({
  title,
  data,
  series,
  format,
  height = 200,
  domain
}: {
  title: string
  data: Point[]
  series: { key: string; label: string }[]
  format: (v: number) => string
  height?: number
  domain?: [number | 'auto', number | 'auto']
}): ReactNode {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1 text-xs font-semibold text-ink">{title}</div>
      {data.length < 2 || series.length === 0 ? (
        <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
          Henüz yeterli geçmiş yok
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -10 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={clock} minTickGap={40} {...axisProps} />
            <YAxis width={52} domain={domain ?? [0, 'auto']} tickFormatter={format} {...axisProps} />
            <Tooltip
              {...tooltipStyle}
              labelFormatter={(v) => dateTime(Number(v))}
              formatter={(v, name) => [typeof v === 'number' ? format(v) : '—', String(name)]}
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
            />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, color: 'var(--ink-2)', paddingTop: 4 }} />
            {series.slice(0, 8).map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={SERIES[i]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Uzun seriyi en fazla `max` noktaya indirger (ortalama ile). */
export function downsample<T extends { ts: number }>(rows: T[], max = 400): T[] {
  if (rows.length <= max) return rows
  const step = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)])
  return out
}
