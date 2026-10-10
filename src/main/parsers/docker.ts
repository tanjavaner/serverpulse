import type { ContainerInfo, DockerDfRow } from '@shared/types'

/** JSON-lines çıktısını satır satır parse eder; bozuk satırları atlar. */
export function parseJsonLines<T = Record<string, unknown>>(out: string): T[] {
  const rows: T[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      rows.push(JSON.parse(t) as T)
    } catch {
      /* yok say */
    }
  }
  return rows
}

/** "a=b,c=d" biçimindeki docker label string'i. Değerlerde virgül olabilir; anahtar deseniyle ayrıştırılır. */
export function parseLabels(s: string | undefined): Record<string, string> {
  const res: Record<string, string> = {}
  if (!s) return res
  const re = /(?:^|,)([A-Za-z0-9_.\-/]+)=/g
  const marks: { key: string; start: number; valueStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) marks.push({ key: m[1], start: m.index, valueStart: re.lastIndex })
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : s.length
    res[mk.key] = s.slice(mk.valueStart, end)
  })
  return res
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4
}

/** "123.4MiB", "1.2GB", "0B" → byte */
export function parseSize(s: string | undefined): number | null {
  if (!s) return null
  const m = /^([\d.]+)\s*([A-Za-z]*)$/.exec(s.trim())
  if (!m) return null
  const mult = UNITS[(m[2] || 'B').toUpperCase()]
  const v = Number(m[1])
  return mult && Number.isFinite(v) ? v * mult : null
}

export function parsePercent(s: string | undefined): number | null {
  if (!s) return null
  const v = Number(s.replace('%', '').trim())
  return Number.isFinite(v) ? v : null
}

export function healthFromStatus(status: string): ContainerInfo['health'] {
  if (/\(healthy\)/.test(status)) return 'healthy'
  if (/\(unhealthy\)/.test(status)) return 'unhealthy'
  if (/\(health: starting\)/.test(status)) return 'starting'
  return null
}

interface PsRow {
  ID?: string
  Names?: string
  Image?: string
  State?: string
  Status?: string
  Labels?: string
  Ports?: string
}

interface StatsRow {
  ID?: string
  Container?: string
  Name?: string
  CPUPerc?: string
  MemUsage?: string
  MemPerc?: string
}

export function parseDockerPs(out: string): ContainerInfo[] {
  return parseJsonLines<PsRow>(out)
    .filter((r) => r.Names)
    .map((r) => {
      const labels = parseLabels(r.Labels)
      const status = r.Status ?? ''
      let state = (r.State ?? '').toLowerCase()
      if (!state) state = /^Up/.test(status) ? 'running' : /^Exited/.test(status) ? 'exited' : 'unknown'
      return {
        id: r.ID ?? '',
        name: (r.Names ?? '').split(',')[0],
        image: r.Image ?? '',
        state,
        status,
        health: healthFromStatus(status),
        restartCount: null,
        lastRestartIncreaseAt: null,
        composeProject: labels['com.docker.compose.project'],
        workingDir: labels['com.docker.compose.project.working_dir'],
        composeFiles: labels['com.docker.compose.project.config_files']
          ?.split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        ports: r.Ports ?? '',
        cpuPct: null,
        memBytes: null,
        memPct: null
      }
    })
}

export function parseDockerStats(out: string): Map<string, { cpuPct: number | null; memBytes: number | null; memPct: number | null }> {
  const map = new Map<string, { cpuPct: number | null; memBytes: number | null; memPct: number | null }>()
  for (const r of parseJsonLines<StatsRow>(out)) {
    const name = r.Name
    if (!name) continue
    map.set(name, {
      cpuPct: parsePercent(r.CPUPerc),
      memBytes: parseSize(r.MemUsage?.split('/')[0]),
      memPct: parsePercent(r.MemPerc)
    })
  }
  return map
}

/** "/name|3|2026-09-27T10:00:00Z" satırları */
export function parseInspectLines(out: string): Map<string, { restartCount: number | null; startedAt: string }> {
  const map = new Map<string, { restartCount: number | null; startedAt: string }>()
  for (const line of out.split('\n')) {
    const f = line.trim().split('|')
    if (f.length < 3 || !f[0].startsWith('/')) continue
    const n = Number(f[1])
    map.set(f[0].slice(1), { restartCount: Number.isFinite(n) ? n : null, startedAt: f[2] })
  }
  return map
}

/** docker ps + stats + inspect birleştirme. prevRestarts: bir önceki ölçümdeki restart sayıları. */
export function mergeDocker(
  ps: ContainerInfo[],
  stats: ReturnType<typeof parseDockerStats>,
  inspect: ReturnType<typeof parseInspectLines>,
  prev: Map<string, { restartCount: number | null; lastRestartIncreaseAt: number | null }>,
  now: number
): ContainerInfo[] {
  return ps.map((c) => {
    const s = stats.get(c.name)
    const ins = inspect.get(c.name)
    const p = prev.get(c.name)
    const restartCount = ins?.restartCount ?? null
    let lastRestartIncreaseAt = p?.lastRestartIncreaseAt ?? null
    if (p?.restartCount != null && restartCount != null && restartCount > p.restartCount) lastRestartIncreaseAt = now
    return {
      ...c,
      cpuPct: s?.cpuPct ?? null,
      memBytes: s?.memBytes ?? null,
      memPct: s?.memPct ?? null,
      restartCount,
      lastRestartIncreaseAt
    }
  })
}

export function parseSystemDf(out: string): DockerDfRow[] {
  return parseJsonLines<Record<string, string>>(out).map((r) => ({
    type: r.Type ?? '?',
    total: Number(r.TotalCount ?? 0) || 0,
    active: Number(r.Active ?? 0) || 0,
    size: r.Size ?? '',
    reclaimable: r.Reclaimable ?? ''
  }))
}

export function isDockerPermissionError(out: string): boolean {
  return /permission denied.*docker/i.test(out) || /Got permission denied while trying to connect to the Docker daemon/i.test(out)
}

export function isDockerMissing(out: string): boolean {
  return /docker: (command )?not found/i.test(out) || /Cannot connect to the Docker daemon/i.test(out)
}

/** "127.0.0.1:8082->8000/tcp, [::]:..." → yayınlanan {ip, port} listesi */
export function parsePublishedPorts(ports: string): { ip: string; port: number }[] {
  const res: { ip: string; port: number }[] = []
  const re = /(\d{1,3}(?:\.\d{1,3}){3}):(\d+)->\d+\/tcp/g
  let m: RegExpExecArray | null
  while ((m = re.exec(ports))) {
    const item = { ip: m[1], port: Number(m[2]) }
    if (!res.some((r) => r.ip === item.ip && r.port === item.port)) res.push(item)
  }
  return res
}
