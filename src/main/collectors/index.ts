import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { AppSettings, HttpCheck, ProjectConfig, ServerConfig, ServerState } from '@shared/types'
import type { SshConnection } from '../ssh/connection'
import { CMD, buildScript, parseSections, safeName } from '../ssh/commands'
import { parseHost, type CpuStat } from '../parsers/host'
import {
  isDockerMissing,
  isDockerPermissionError,
  mergeDocker,
  parseDockerPs,
  parseDockerStats,
  parseInspectLines,
  parseSystemDf
} from '../parsers/docker'
import {
  isSudoDenied,
  parseChannelsCount,
  parseCurl,
  parseDbSizes,
  parseEndpoints,
  parseFailedUnits,
  parseIsActive,
  parsePgIsReady,
  parseRegistrations,
  parseSingleInt
} from '../parsers/misc'
import type { HistoryStore } from '../store/history'
import { hostOf } from '../alerts/evaluate'

/** Collector'lar arasında sunucu başına bellekte tutulan önceki örnekler. */
export interface ServerMemory {
  prevStat: CpuStat | null
  prevRestarts: Map<string, { restartCount: number | null; lastRestartIncreaseAt: number | null }>
}

export interface CollectorCtx {
  server: ServerConfig
  projects: ProjectConfig[]
  conn: SshConnection
  state: ServerState
  settings: AppSettings
  history: HistoryStore
  mem: ServerMemory
}

export type CollectorName =
  | 'reach'
  | 'host'
  | 'docker'
  | 'dockerMeta'
  | 'systemd'
  | 'httpLocal'
  | 'httpPublic'
  | 'ssl'
  | 'postgres'
  | 'asterisk'

export interface CollectorDef {
  name: CollectorName
  needsSsh: boolean
  intervalMs: (s: AppSettings) => number
  enabled: (ctx: Pick<CollectorCtx, 'server' | 'projects'>) => boolean
  run: (ctx: CollectorCtx) => Promise<void>
}

// ---------------------------------------------------------------------------

export function tcpPing(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const sock = netConnect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('TCP zaman aşımı'))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(Date.now() - t0)
    })
    sock.once('error', (e) => {
      clearTimeout(timer)
      sock.destroy()
      reject(e)
    })
  })
}

const reach: CollectorDef = {
  name: 'reach',
  needsSsh: false,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: () => true,
  async run({ server, conn, state }) {
    const ts = Date.now()
    let tcpOk = false
    let tcpMs: number | null = null
    let sshOk = false
    let sshMs: number | null = null
    let error: string | undefined
    try {
      tcpMs = await tcpPing(server.host, server.port, 5000)
      tcpOk = true
    } catch (e) {
      error = `TCP ${server.port}: ${(e as Error).message}`
    }
    if (tcpOk) {
      if (conn.isReady) {
        try {
          const r = await conn.exec('true', 10000)
          sshOk = r.code === 0
          sshMs = r.ms
        } catch (e) {
          error = (e as Error).message
        }
      } else {
        error = conn.error ?? 'SSH bağlı değil'
        // Ağ geri geldiyse geri çekilme süresini beklemeden yeniden dene
        if (conn.status === 'error') conn.reconnectNow()
      }
    }
    const failed = !tcpOk || (!sshOk && conn.status !== 'connecting')
    const prev = state.reach?.consecutiveFailures ?? 0
    state.reach = { ts, tcpOk, tcpMs, sshOk, sshMs, consecutiveFailures: failed ? prev + 1 : 0, error: failed ? error : undefined }
  }
}

const host: CollectorDef = {
  name: 'host',
  needsSsh: true,
  intervalMs: (s) => s.intervals.fastSec * 1000,
  enabled: () => true,
  async run({ conn, state, mem, settings, history, server }) {
    const r = await conn.exec(buildScript(CMD.host()), 15000)
    const now = Date.now()
    const { metrics, stat } = parseHost(parseSections(r.stdout), mem.prevStat, now)
    mem.prevStat = stat
    const high = metrics.memPct != null && metrics.memPct >= settings.thresholds.ramPct
    state.host = { ...metrics, memHighSince: high ? (state.host?.memHighSince ?? now) : null }
    history.addHost(server.id, state.host)
  }
}

const docker: CollectorDef = {
  name: 'docker',
  needsSsh: true,
  intervalMs: (s) => s.intervals.fastSec * 1000,
  enabled: () => true,
  async run({ conn, state, mem, history, server }) {
    const r = await conn.exec(buildScript(CMD.docker()), 30000)
    const now = Date.now()
    const sec = parseSections(r.stdout)
    const psOut = sec.ps?.out ?? ''
    if (isDockerPermissionError(psOut)) {
      state.docker = { ts: now, available: false, error: "Kullanıcının docker'a erişimi yok (docker grubuna eklenmeli)", containers: [] }
      return
    }
    if (isDockerMissing(psOut) || (sec.ps?.rc ?? 1) !== 0) {
      state.docker = { ts: now, available: false, error: psOut.split('\n')[0] || 'docker ps başarısız', containers: [] }
      return
    }
    const ps = parseDockerPs(psOut)
    if (ps.length === 0 && psOut.trim().length > 0) {
      state.docker = { ts: now, available: false, error: 'docker ps çıktısı çözümlenemedi (bilinmiyor)', containers: [] }
      return
    }
    const containers = mergeDocker(ps, parseDockerStats(sec.stats?.out ?? ''), parseInspectLines(sec.inspect?.out ?? ''), mem.prevRestarts, now)
    mem.prevRestarts = new Map(containers.map((c) => [c.name, { restartCount: c.restartCount, lastRestartIncreaseAt: c.lastRestartIncreaseAt }]))
    state.docker = { ts: now, available: true, containers }
    history.addContainers(server.id, now, containers)
  }
}

const dockerMeta: CollectorDef = {
  name: 'dockerMeta',
  needsSsh: true,
  intervalMs: (s) => s.intervals.slowSec * 1000,
  enabled: () => true,
  async run({ conn, state }) {
    const r = await conn.exec(buildScript(CMD.dockerMeta()), 60000)
    const sec = parseSections(r.stdout)
    const ok = (sec.df?.rc ?? 1) === 0
    state.dockerMeta = { ts: Date.now(), df: ok ? parseSystemDf(sec.df.out) : [], error: ok ? undefined : sec.df?.out.split('\n')[0] }
  }
}

export function allUnits(server: ServerConfig, projects: ProjectConfig[]): string[] {
  const set = new Set<string>()
  for (const u of [...server.systemdUnits, ...projects.flatMap((p) => p.systemdUnits)]) {
    try {
      set.add(safeName(u))
    } catch {
      /* geçersiz ad atlanır */
    }
  }
  return [...set]
}

const systemd: CollectorDef = {
  name: 'systemd',
  needsSsh: true,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: () => true,
  async run({ conn, state, server, projects }) {
    const units = allUnits(server, projects)
    const r = await conn.exec(buildScript(CMD.systemd(units)), 15000)
    const sec = parseSections(r.stdout)
    state.systemd = {
      ts: Date.now(),
      units: units.length ? parseIsActive(units, sec.active?.out ?? '') : [],
      failed: parseFailedUnits(sec.failed?.out ?? '')
    }
  }
}

function checksOf(projects: ProjectConfig[], mode: HttpCheck['mode']): HttpCheck[] {
  return projects.flatMap((p) => p.httpChecks.filter((c) => c.mode === mode))
}

const httpLocal: CollectorDef = {
  name: 'httpLocal',
  needsSsh: true,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: ({ projects }) => checksOf(projects, 'local').length > 0,
  async run({ conn, state, projects, settings, history }) {
    const valid: HttpCheck[] = []
    const now = Date.now()
    for (const c of checksOf(projects, 'local')) {
      try {
        CMD.httpLocal([{ host: c.host ?? '127.0.0.1', port: c.port ?? 0, path: c.path }], 1)
        valid.push(c)
      } catch (e) {
        state.http[c.id] = { checkId: c.id, ts: now, ok: false, status: null, ms: null, error: (e as Error).message }
      }
    }
    if (!valid.length) return
    const t = settings.thresholds.httpTimeoutSec
    const script = buildScript(CMD.httpLocal(valid.map((c) => ({ host: c.host ?? '127.0.0.1', port: c.port ?? 0, path: c.path })), t))
    const r = await conn.exec(script, (t * valid.length + 15) * 1000)
    const sec = parseSections(r.stdout)
    valid.forEach((c, i) => {
      const s = sec[`h${i}`]
      const res = s ? parseCurl(s.out, s.rc) : { ok: false, status: null, ms: null, error: 'Sonuç yok' }
      state.http[c.id] = { checkId: c.id, ts: Date.now(), ...res }
      history.addHttp(c.id, Date.now(), res.status, res.ms)
    })
  }
}

export async function fetchCheck(url: string, timeoutSec: number): Promise<{ ok: boolean; status: number | null; ms: number | null; error?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'ServerPulse/0.1 (+health-check)' },
      signal: AbortSignal.timeout(timeoutSec * 1000)
    })
    const ms = Math.round(performance.now() - t0)
    await res.body?.cancel().catch(() => undefined)
    return { ok: res.status < 500, status: res.status, ms, error: res.status >= 500 ? `HTTP ${res.status}` : undefined }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const msg = err.name === 'TimeoutError' ? 'Zaman aşımı' : (err.cause?.code ?? err.cause?.message ?? err.message)
    return { ok: false, status: null, ms: null, error: msg }
  }
}

const httpPublic: CollectorDef = {
  name: 'httpPublic',
  needsSsh: false,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: ({ projects }) => checksOf(projects, 'public').length > 0,
  async run({ state, projects, settings, history }) {
    await Promise.all(
      checksOf(projects, 'public').map(async (c) => {
        if (!c.url || !/^https?:\/\//.test(c.url)) {
          state.http[c.id] = { checkId: c.id, ts: Date.now(), ok: false, status: null, ms: null, error: 'Geçersiz URL' }
          return
        }
        const res = await fetchCheck(c.url, settings.thresholds.httpTimeoutSec)
        state.http[c.id] = { checkId: c.id, ts: Date.now(), ...res }
        history.addHttp(c.id, Date.now(), res.status, res.ms)
      })
    )
  }
}

export function readCertificate(host: string, port = 443, timeoutMs = 10000): Promise<{ validTo: string; daysLeft: number; authorized: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate()
      const authorized = sock.authorized
      const authErr = sock.authorizationError ? String(sock.authorizationError) : undefined
      sock.end()
      if (!cert || !cert.valid_to) return reject(new Error('Sertifika okunamadı'))
      const validTo = new Date(cert.valid_to)
      resolve({
        validTo: validTo.toISOString(),
        daysLeft: (validTo.getTime() - Date.now()) / 86400_000,
        authorized,
        error: authorized ? undefined : authErr
      })
    })
    sock.on('timeout', () => {
      sock.destroy()
      reject(new Error('TLS zaman aşımı'))
    })
    sock.on('error', reject)
  })
}

const ssl: CollectorDef = {
  name: 'ssl',
  needsSsh: false,
  intervalMs: (s) => s.intervals.sslHours * 3600_000,
  enabled: ({ projects }) => checksOf(projects, 'public').some((c) => c.url?.startsWith('https://')),
  async run({ state, projects }) {
    const hosts = new Set<string>()
    for (const c of checksOf(projects, 'public')) {
      const h = c.url?.startsWith('https://') ? hostOf(c.url) : null
      if (h) hosts.add(h)
    }
    await Promise.all(
      [...hosts].map(async (h) => {
        try {
          const c = await readCertificate(h)
          state.ssl[h] = { host: h, ts: Date.now(), ...c }
        } catch (e) {
          state.ssl[h] = { host: h, ts: Date.now(), daysLeft: null, authorized: false, error: (e as Error).message }
        }
      })
    )
  }
}

const postgres: CollectorDef = {
  name: 'postgres',
  needsSsh: true,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: ({ projects }) => projects.some((p) => p.postgres),
  async run({ conn, state, projects }) {
    for (const p of projects) {
      if (!p.postgres) continue
      const ts = Date.now()
      try {
        const r = await conn.exec(buildScript(CMD.postgres(p.postgres.container, p.postgres.user)), 20000)
        const sec = parseSections(r.stdout)
        const ready = parsePgIsReady(sec.ready?.out ?? '', sec.ready?.rc ?? null)
        const connsOk = sec.conns?.rc === 0
        state.postgres[p.id] = {
          ts,
          ready,
          connections: connsOk ? parseSingleInt(sec.conns.out) : null,
          databases: sec.sizes?.rc === 0 ? parseDbSizes(sec.sizes.out) : [],
          error: ready === false ? sec.ready?.out.trim() : !connsOk ? sec.conns?.out.split('\n')[0] : undefined
        }
      } catch (e) {
        state.postgres[p.id] = { ts, ready: null, connections: null, databases: [], error: (e as Error).message }
      }
    }
  }
}

const asterisk: CollectorDef = {
  name: 'asterisk',
  needsSsh: true,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: ({ server }) => server.asterisk,
  async run({ conn, state, server }) {
    const r = await conn.exec(buildScript(CMD.asterisk(server.username === 'root')), 20000)
    const sec = parseSections(r.stdout)
    const ch = sec.channels
    const ts = Date.now()
    if (!ch || ch.rc !== 0 || isSudoDenied(ch.out)) {
      state.asterisk = {
        ts,
        mode: 'limited',
        activeChannels: null,
        activeCalls: null,
        callsProcessed: null,
        registrations: [],
        endpoints: [],
        error: isSudoDenied(ch?.out ?? '')
          ? 'sudoers kuralı yok; sadece systemd durumu gösteriliyor'
          : (ch?.out.split('\n')[0] ?? 'asterisk -rx başarısız')
      }
      return
    }
    state.asterisk = {
      ts,
      mode: 'full',
      ...parseChannelsCount(ch.out),
      registrations: sec.registrations?.rc === 0 ? parseRegistrations(sec.registrations.out) : [],
      endpoints: sec.endpoints?.rc === 0 ? parseEndpoints(sec.endpoints.out) : []
    }
  }
}

export const COLLECTORS: CollectorDef[] = [reach, host, docker, dockerMeta, systemd, httpLocal, httpPublic, ssl, postgres, asterisk]
