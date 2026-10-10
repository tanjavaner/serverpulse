import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { AppSettings, HttpCheck, HttpResult, ProjectConfig, ServerConfig, ServerState } from '@shared/types'
import { t } from '@shared/i18n'
import { ExecTimeoutError, type SshConnection } from '../ssh/connection'
import { CMD, buildScript, parseSections, safeName } from '../ssh/commands'
import { parseHost, type CpuStat, type NetCounters } from '../parsers/host'
import { parseAuthFailures, parseInodes, parseListenPorts, parseNoLogRotation, parseSshdConfig } from '../parsers/insight'
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
import { statusMatches } from '@shared/http'

/** Collector'lar arasında sunucu başına bellekte tutulan önceki örnekler. */
export interface ServerMemory {
  prevStat: CpuStat | null
  prevNet: NetCounters | null
  /** Hafif mod: son docker stats zamanı. */
  lastStatsAt?: number
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
  | 'storage'
  | 'security'

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
      reject(new Error(t('err.tcpTimeout')))
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
          // Yanıt vermeyen (yarı açık) TCP bağlantısını keepalive'ı beklemeden yenile
          if (e instanceof ExecTimeoutError) conn.reconnectNow()
        }
      } else {
        error = conn.error ?? t('err.sshNotConnected')
        // Ağ geri geldiyse geri çekilme süresini beklemeden yeniden dene.
        // auth-failed ve hostkey-mismatch bilerek hariç: kullanıcı müdahalesi gerekir.
        if (conn.status === 'error') conn.reconnectNow()
      }
    }
    // Kimlik doğrulama hatası erişim sorunu değildir; ayrı alarm olarak raporlanır
    const failed = !tcpOk || (!sshOk && conn.status !== 'connecting' && conn.status !== 'auth-failed')
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
    const { metrics, stat, net } = parseHost(parseSections(r.stdout), mem.prevStat, now, mem.prevNet)
    mem.prevStat = stat
    mem.prevNet = net
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
  async run({ conn, state, mem, history, server, settings }) {
    const now = Date.now()
    // Hafif mod: stats en fazla orta aralıkta bir alınır; aradaki turlarda son CPU/RAM değerleri korunur
    const withStats = !settings.lightMode || now - (mem.lastStatsAt ?? 0) >= settings.intervals.mediumSec * 1000
    const r = await conn.exec(buildScript(CMD.docker(withStats)), 30000)
    const sec = parseSections(r.stdout)
    const psOut = sec.ps?.out ?? ''
    if (isDockerPermissionError(psOut)) {
      state.docker = { ts: now, available: false, error: t('err.dockerPermission'), containers: [] }
      return
    }
    if (isDockerMissing(psOut) || (sec.ps?.rc ?? 1) !== 0) {
      state.docker = { ts: now, available: false, error: psOut.split('\n')[0] || t('err.dockerPsFailed'), containers: [] }
      return
    }
    const ps = parseDockerPs(psOut)
    if (ps.length === 0 && psOut.trim().length > 0) {
      state.docker = { ts: now, available: false, error: t('err.dockerPsUnparsed'), containers: [] }
      return
    }
    const stats = withStats ? parseDockerStats(sec.stats?.out ?? '') : previousStats(state)
    if (withStats) mem.lastStatsAt = now
    const containers = mergeDocker(ps, stats, parseInspectLines(sec.inspect?.out ?? ''), mem.prevRestarts, now)
    mem.prevRestarts = new Map(containers.map((c) => [c.name, { restartCount: c.restartCount, lastRestartIncreaseAt: c.lastRestartIncreaseAt }]))
    state.docker = { ts: now, available: true, containers }
    history.addContainers(server.id, now, containers)
  }
}

/** Hafif modda stats alınmayan turlarda bir önceki CPU/RAM değerleri. */
function previousStats(state: ServerState): ReturnType<typeof parseDockerStats> {
  return new Map((state.docker?.containers ?? []).map((c) => [c.name, { cpuPct: c.cpuPct, memBytes: c.memBytes, memPct: c.memPct }]))
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

/** HTTP sonucunu yazar; ardışık hata sayacını (alarm eşiği için) günceller. */
type RawHttp = { status: number | null; ms: number | null; error?: string }

/**
 * Ham yanıtı kontrolün beklentilerine göre değerlendirir: durum kodu kuralı (yoksa 5xx hata), anahtar kelime,
 * yavaş yanıt. Bağlantı hatası (status null) her zaman başarısızdır.
 */
export function judgeHttp(r: RawHttp, c: Pick<HttpCheck, 'expectStatus' | 'keyword' | 'slowMs'>, keywordFound?: boolean): Omit<HttpResult, 'checkId' | 'ts'> & { slow: boolean } {
  if (r.status == null) return { ok: false, status: null, ms: r.ms, error: r.error, slow: false }
  const statusOk = c.expectStatus ? statusMatches(r.status, c.expectStatus) : r.status < 500
  if (!statusOk) return { ok: false, status: r.status, ms: r.ms, error: c.expectStatus ? t('err.unexpectedStatus', { s: r.status }) : `HTTP ${r.status}`, slow: false }
  if (c.keyword && keywordFound === false) return { ok: false, status: r.status, ms: r.ms, error: t('err.keywordMissing', { k: c.keyword }), slow: false }
  return { ok: true, status: r.status, ms: r.ms, slow: !!c.slowMs && r.ms != null && r.ms > c.slowMs }
}

/** HTTP sonucunu yazar; ardışık hata ve yavaşlık sayaçlarını (alarm eşiği için) günceller. */
export function setHttp(state: ServerState, checkId: string, res: Omit<HttpResult, 'checkId' | 'ts' | 'failures' | 'slowStreak'> & { slow?: boolean }): void {
  const prev = state.http[checkId]
  const { slow, ...rest } = res
  const failures = res.ok ? 0 : (prev?.failures ?? 0) + 1
  const slowStreak = slow ? (prev?.slowStreak ?? 0) + 1 : 0
  state.http[checkId] = { checkId, ts: Date.now(), ...rest, failures, slowStreak }
}

/** curl bölüm çıktısından "@@KW 1|0" satırını ayırır. */
export function splitKeyword(out: string): { out: string; found?: boolean } {
  const m = /\n?@@KW ([01])\s*$/.exec(out)
  return m ? { out: out.slice(0, m.index), found: m[1] === '1' } : { out }
}

const httpLocal: CollectorDef = {
  name: 'httpLocal',
  needsSsh: true,
  intervalMs: (s) => s.intervals.mediumSec * 1000,
  enabled: ({ projects }) => checksOf(projects, 'local').length > 0,
  async run({ conn, state, projects, settings, history }) {
    const valid: HttpCheck[] = []
    const spec = (c: HttpCheck): { host: string; port: number; path?: string; keyword?: string } => ({
      host: c.host ?? '127.0.0.1',
      port: c.port ?? 0,
      path: c.path,
      keyword: c.keyword || undefined
    })
    for (const c of checksOf(projects, 'local')) {
      try {
        CMD.httpLocal([spec(c)], 1)
        valid.push(c)
      } catch (e) {
        setHttp(state, c.id, { ok: false, status: null, ms: null, error: (e as Error).message })
      }
    }
    if (!valid.length) return
    const timeoutSec = settings.thresholds.httpTimeoutSec
    const script = buildScript(CMD.httpLocal(valid.map(spec), timeoutSec))
    const r = await conn.exec(script, (timeoutSec * valid.length + 15) * 1000)
    const sec = parseSections(r.stdout)
    valid.forEach((c, i) => {
      const s = sec[`h${i}`]
      const kw = s ? splitKeyword(s.out) : { out: '' }
      const raw = s ? parseCurl(kw.out, s.rc) : { status: null, ms: null, error: t('err.noResult') }
      const res = judgeHttp(raw, c, kw.found)
      setHttp(state, c.id, res)
      history.addHttp(c.id, Date.now(), res.status, res.ms, res.ok)
    })
  }
}

const BODY_LIMIT = 256 * 1024

/** Gövdenin ilk BODY_LIMIT baytını okur (anahtar kelime araması için), kalanını iptal eder. */
async function readBodyPrefix(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < BODY_LIMIT) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks).subarray(0, BODY_LIMIT).toString('utf8')
}

/** PC'den istek: yanıt süresi başlıklar gelene kadar ölçülür; anahtar kelime varsa gövdede aranır. */
export async function fetchCheck(url: string, timeoutSec: number, keyword?: string): Promise<RawHttp & { keywordFound?: boolean }> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'ServerPulse/0.4 (+health-check)' },
      signal: AbortSignal.timeout(timeoutSec * 1000)
    })
    const ms = Math.round(performance.now() - t0)
    if (!keyword) {
      await res.body?.cancel().catch(() => undefined)
      return { status: res.status, ms }
    }
    return { status: res.status, ms, keywordFound: (await readBodyPrefix(res)).includes(keyword) }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const msg = err.name === 'TimeoutError' ? t('err.timeout') : (err.cause?.code ?? err.cause?.message ?? err.message)
    return { status: null, ms: null, error: msg }
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
          setHttp(state, c.id, { ok: false, status: null, ms: null, error: t('err.badUrlShort') })
          return
        }
        const raw = await fetchCheck(c.url, settings.thresholds.httpTimeoutSec, c.keyword || undefined)
        const res = judgeHttp(raw, c, raw.keywordFound)
        setHttp(state, c.id, res)
        history.addHttp(c.id, Date.now(), res.status, res.ms, res.ok)
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
      if (!cert || !cert.valid_to) return reject(new Error(t('err.certUnreadable')))
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
      reject(new Error(t('err.tlsTimeout')))
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
        const prev = state.postgres[p.id]?.failures ?? 0
        state.postgres[p.id] = {
          ts,
          ready,
          connections: connsOk ? parseSingleInt(sec.conns.out) : null,
          databases: sec.sizes?.rc === 0 ? parseDbSizes(sec.sizes.out) : [],
          error: ready === false ? sec.ready?.out.trim() : !connsOk ? sec.conns?.out.split('\n')[0] : undefined,
          failures: ready === false ? prev + 1 : 0
        }
      } catch (e) {
        // Bilinmeyen durum: sayaç korunur (ne artar ne sıfırlanır)
        state.postgres[p.id] = { ts, ready: null, connections: null, databases: [], error: (e as Error).message, failures: state.postgres[p.id]?.failures }
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
          ? t('err.astNoSudoers')
          : (ch?.out.split('\n')[0] ?? t('err.astFailed'))
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

const storage: CollectorDef = {
  name: 'storage',
  needsSsh: true,
  intervalMs: (s) => s.intervals.slowSec * 1000,
  enabled: () => true,
  async run({ conn, state }) {
    const sec = parseSections((await conn.exec(buildScript(CMD.storage()), 60000)).stdout)
    state.storage = { ts: Date.now(), inodes: parseInodes(sec.inodes?.out ?? ''), noLogRotation: parseNoLogRotation(sec.logcfg?.out ?? '') }
  }
}

const security: CollectorDef = {
  name: 'security',
  needsSsh: true,
  intervalMs: (s) => s.intervals.slowSec * 1000,
  enabled: () => true,
  async run({ conn, state }) {
    const sec = parseSections((await conn.exec(buildScript(CMD.security()), 60000)).stdout)
    state.security = {
      ts: Date.now(),
      auth: parseAuthFailures(sec.auth?.out ?? ''),
      sshd: parseSshdConfig(sec.sshd?.out ?? ''),
      fail2ban: (sec.f2b?.out.trim().split('\n')[0] || 'unknown').trim(),
      unattended: (sec.uu?.out.trim().split('\n')[0] || 'unknown').trim(),
      ports: sec.ports?.rc === 0 ? parseListenPorts(sec.ports.out) : (state.security?.ports ?? [])
    }
  }
}

export const COLLECTORS: CollectorDef[] = [reach, host, docker, dockerMeta, systemd, httpLocal, httpPublic, ssl, postgres, asterisk, storage, security]
