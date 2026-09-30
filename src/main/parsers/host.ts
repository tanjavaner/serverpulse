import type { DiskInfo, HostMetrics } from '@shared/types'
import type { SectionOutput } from '../ssh/commands'

export interface CpuStat {
  total: number
  idle: number
}

export function parseLoadavg(out: string): [number, number, number] | null {
  const parts = out.trim().split(/\s+/).slice(0, 3).map(Number)
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as [number, number, number]) : null
}

/** /proc/meminfo → byte cinsinden alanlar. */
export function parseMeminfo(out: string): Record<string, number> {
  const res: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line.trim())
    if (m) res[m[1]] = Number(m[2]) * (line.includes('kB') ? 1024 : 1)
  }
  return res
}

export function parseUptime(out: string): number | null {
  const v = Number(out.trim().split(/\s+/)[0])
  return Number.isFinite(v) ? v : null
}

/** "cpu  user nice system idle iowait irq softirq steal guest guest_nice" */
export function parseProcStat(out: string): CpuStat | null {
  const line = out.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return null
  const f = line.trim().split(/\s+/).slice(1).map(Number)
  if (f.length < 4 || f.slice(0, 4).some((n) => !Number.isFinite(n))) return null
  // guest/guest_nice zaten user/nice içinde sayıldığı için ilk 8 alan toplanır.
  const total = f.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  const idle = f[3] + (Number.isFinite(f[4]) ? f[4] : 0)
  return { total, idle }
}

export function cpuPercent(prev: CpuStat | null, cur: CpuStat | null): number | null {
  if (!prev || !cur) return null
  const dt = cur.total - prev.total
  const di = cur.idle - prev.idle
  if (dt <= 0) return null
  return Math.max(0, Math.min(100, ((dt - di) / dt) * 100))
}

export function parseDf(out: string): DiskInfo[] {
  const disks: DiskInfo[] = []
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6) continue
    const [fs, size, used, avail, cap] = f
    const mount = f.slice(5).join(' ')
    const nSize = Number(size)
    const nUsed = Number(used)
    const nAvail = Number(avail)
    if (![nSize, nUsed, nAvail].every(Number.isFinite) || nSize === 0) continue
    const pct = Number(cap.replace('%', ''))
    disks.push({
      fs,
      mount,
      size: nSize,
      used: nUsed,
      avail: nAvail,
      pct: Number.isFinite(pct) ? pct : Math.round((nUsed / (nUsed + nAvail)) * 100)
    })
  }
  return disks
}

/** host collector bölümlerini birleştirir. Hatalı bölüm alanı null yapar, istisna fırlatmaz. */
export function parseHost(
  sections: Record<string, SectionOutput>,
  prevStat: CpuStat | null,
  now: number
): { metrics: Omit<HostMetrics, 'memHighSince'>; stat: CpuStat | null } {
  const txt = (k: string): string => sections[k]?.out ?? ''
  const mem = parseMeminfo(txt('meminfo'))
  const memTotal = mem.MemTotal ?? null
  const memAvail = mem.MemAvailable ?? (mem.MemFree != null ? mem.MemFree + (mem.Buffers ?? 0) + (mem.Cached ?? 0) : null)
  const memUsed = memTotal != null && memAvail != null ? memTotal - memAvail : null
  const stat = parseProcStat(txt('stat'))
  const cores = Number.parseInt(txt('nproc').trim(), 10)
  return {
    stat,
    metrics: {
      ts: now,
      cpuPct: cpuPercent(prevStat, stat),
      cores: Number.isFinite(cores) ? cores : null,
      load: parseLoadavg(txt('loadavg')),
      memTotal,
      memUsed,
      memPct: memTotal && memUsed != null ? (memUsed / memTotal) * 100 : null,
      swapTotal: mem.SwapTotal ?? null,
      swapUsed: mem.SwapTotal != null && mem.SwapFree != null ? mem.SwapTotal - mem.SwapFree : null,
      uptimeSec: parseUptime(txt('uptime')),
      disks: parseDf(txt('df'))
    }
  }
}
