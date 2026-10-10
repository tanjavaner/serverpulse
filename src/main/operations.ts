import { readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { utils as sshUtils } from 'ssh2'
import type {
  ActionResult,
  ContainerAction,
  DiscoveryResult,
  HostKeyProbe,
  LogOptions,
  LogResult,
  PromPreset,
  ProcessResult,
  PromResult,
  PublicKeyResult,
  ServerInput,
  TestResult
} from '@shared/types'
import { normalizePubKey } from '@shared/setup'
import { t, type MsgKey } from '@shared/i18n'
import type { Monitor } from './monitor'
import { CMD, buildScript, parseSections, safeName } from './ssh/commands'
import { execOn, probeHostKey, withTempConnection } from './ssh/connection'
import { isDockerPermissionError, parseDockerPs } from './parsers/docker'
import { parseNginxSites, parseRunningUnits } from './parsers/misc'
import { buildProposals, isPostgresImage, suggestUnits } from './discovery/proposals'
import { parseProcesses } from './parsers/insight'
import { allUnits } from './collectors'

export async function probe(host: string, port: number): Promise<HostKeyProbe> {
  try {
    const r = await probeHostKey(host, port)
    return { ok: true, ...r }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Seçilen (ya da kayıtlı) özel anahtardan authorized_keys satırını üretir; anahtar main dışına çıkmaz. */
export function publicKeyLine(monitor: Monitor, input: { privateKeyPath?: string; serverId?: string; passphrase?: string }): PublicKeyResult {
  try {
    let data: string | undefined
    let passphrase = input.passphrase || undefined
    if (input.privateKeyPath) {
      if (statSync(input.privateKeyPath).size > 64 * 1024) throw new Error(t('err.keyTooLarge'))
      data = readFileSync(input.privateKeyPath, 'utf8')
    } else if (input.serverId) {
      const creds = monitor.secrets.get(input.serverId)
      data = creds?.privateKey
      passphrase ??= creds?.passphrase
    }
    if (!data) throw new Error(t('err.keyRequired'))
    const parsed = sshUtils.parseKey(data, passphrase)
    if (parsed instanceof Error) throw new Error(t('err.keyParse', { e: parsed.message }))
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    const blob = `${key.type} ${key.getPublicSSH().toString('base64')}`
    // Yorumda betiğe uymayan karakter varsa yorumsuz satır kullanılır
    const line = (key.comment ? normalizePubKey(`${blob} ${key.comment}`) : null) ?? normalizePubKey(blob)
    if (!line) throw new Error(t('err.keyParse', { e: key.type }))
    return { ok: true, key: line }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function testConnection(monitor: Monitor, input: ServerInput): Promise<TestResult> {
  const res: TestResult = { ok: false, dockerAccess: false, asteriskAccess: 'unknown', warnings: [] }
  try {
    monitor.validateInput(input)
    const creds = monitor.resolveCreds(input)
    const isRoot = input.username === 'root'
    const t0 = Date.now()
    const out = await withTempConnection(input, creds, input.hostKeyFingerprint, (c) =>
      execOn(c, buildScript(CMD.test(isRoot)), 20000)
    )
    res.latencyMs = Date.now() - t0
    const sec = parseSections(out.stdout)
    res.ok = true
    res.uname = sec.uname?.out.trim()
    res.id = sec.id?.out.trim()
    const dockerOut = sec.docker?.out.trim() ?? ''
    res.dockerAccess = sec.docker?.rc === 0 && /^\d/.test(dockerOut)
    if (res.dockerAccess) res.dockerVersion = dockerOut
    else if (isDockerPermissionError(dockerOut)) res.warnings.push(t('op.notInDocker', { u: input.username }))
    else res.warnings.push(t('op.dockerMissing', { e: dockerOut.split('\n')[0] }))

    if (sec.asterisk_bin?.rc !== 0) res.asteriskAccess = 'not-installed'
    else if (sec.asterisk_sudo?.rc === 0) res.asteriskAccess = 'ok'
    else {
      res.asteriskAccess = 'no-sudo'
      if (input.asterisk) {
        res.warnings.push(t('op.astNoSudoers'))
      }
    }
    if (isRoot) res.warnings.push(t('op.rootWarn'))
    if (input.authType === 'password') res.warnings.push(t('op.passwordWarn'))
  } catch (e) {
    res.error = (e as Error).message
  }
  return res
}

export async function discover(monitor: Monitor, serverId: string): Promise<DiscoveryResult> {
  const empty: DiscoveryResult = { ok: false, proposals: [], runningUnits: [], suggestedUnits: [], containers: [], domains: [] }
  try {
    const r = await monitor.execFor(serverId, buildScript(CMD.discovery()), 60000)
    const sec = parseSections(r.stdout)
    const psOut = sec.ps?.out ?? ''
    if (isDockerPermissionError(psOut)) return { ...empty, error: t('op.noDockerAccess') }
    const containers = parseDockerPs(psOut)
    const runningUnits = parseRunningUnits(sec.units?.out ?? '')
    const nginx = parseNginxSites(sec.nginx?.out ?? '')

    const pgUsers: Record<string, string> = {}
    for (const c of containers.filter((x) => isPostgresImage(x.image) && x.state === 'running')) {
      try {
        const u = await monitor.execFor(serverId, buildScript(CMD.pgUser(c.name)), 15000)
        const val = parseSections(u.stdout).pguser?.out.trim()
        if (val && /^[a-zA-Z0-9_.-]+$/.test(val)) pgUsers[c.name] = val
      } catch {
        /* varsayılan "postgres" kullanılır */
      }
    }

    return {
      ok: true,
      proposals: buildProposals({ serverId, containers, runningUnits, nginx, pgUsers }),
      runningUnits,
      suggestedUnits: suggestUnits(runningUnits),
      containers: containers.map((c) => ({ name: c.name, image: c.image, composeProject: c.composeProject, state: c.state })),
      domains: [...new Set(nginx.flatMap((n) => n.serverNames))]
    }
  } catch (e) {
    return { ...empty, error: (e as Error).message }
  }
}

export async function getLogs(monitor: Monitor, serverId: string, kind: 'container' | 'unit', name: string, opts: LogOptions = {}): Promise<LogResult> {
  try {
    safeName(name)
    const server = monitor.config.server(serverId)
    if (!server) throw new Error(t('err.serverNotFound'))
    // Sadece bilinen (keşfedilmiş/yapılandırılmış) adlar için log okunur
    if (kind === 'container') {
      const known = monitor.state(serverId)?.docker?.containers.some((c) => c.name === name)
      if (!known) throw new Error(t('err.unknownContainer'))
      const r = await monitor.execFor(serverId, CMD.containerLogs(name, opts), 30000)
      return { ok: r.code === 0, lines: r.stdout + r.stderr }
    }
    if (!allUnits(server, monitor.config.projectsOf(serverId)).includes(name)) throw new Error(t('err.unknownUnit'))
    const r = await monitor.execFor(serverId, CMD.unitLogs(name, opts), 30000)
    const out = r.stdout + r.stderr
    if (/No journal files were found|not seeing messages from other users/i.test(out)) {
      return { ok: false, lines: out, error: t('op.journalDenied') }
    }
    return { ok: r.code === 0, lines: out }
  } catch (e) {
    return { ok: false, lines: '', error: (e as Error).message }
  }
}

/** En çok CPU kullanan süreçler (isteğe bağlı, salt okunur). */
export async function listProcesses(monitor: Monitor, serverId: string): Promise<ProcessResult> {
  try {
    if (!monitor.config.server(serverId)) throw new Error(t('err.serverNotFound'))
    const r = await monitor.execFor(serverId, CMD.processes(), 20000)
    const processes = parseProcesses(r.stdout)
    return { ok: processes.length > 0, processes, error: processes.length ? undefined : r.stdout.trim().slice(0, 300) }
  } catch (e) {
    return { ok: false, processes: [], error: (e as Error).message }
  }
}

/** "Total reclaimed space: 1.2GB" satırlarını toplar (safe modda iki satır olabilir). */
export function reclaimedSummary(out: string): string[] {
  return [...out.matchAll(/Total reclaimed space:\s*(\S+)/g)].map((m) => m[1]).filter((v) => !/^0(\.0+)?B$/.test(v))
}

export async function pruneDocker(
  monitor: Monitor,
  serverId: string,
  mode: 'safe' | 'images',
  confirm: (message: string, okLabel: string) => Promise<boolean>
): Promise<ActionResult> {
  try {
    if (!monitor.config.settings.allowActions) throw new Error(t('err.actionsDisabled'))
    const server = monitor.config.server(serverId)
    if (!server) throw new Error(t('err.serverNotFound'))
    const cmd = CMD.prune(mode)
    // Onayda docker system df'in "geri kazanılabilir" değerleri gösterilir
    const df = monitor.state(serverId)?.dockerMeta?.df ?? []
    const reclaim = df
      .filter((r) => (mode === 'images' ? r.type === 'Images' : r.type === 'Images' || r.type === 'Build Cache'))
      .map((r) => `${r.type}: ${r.reclaimable}`)
      .join(', ')
    const key = mode === 'images' ? 'op.pruneImagesConfirm' : 'op.pruneSafeConfirm'
    const ok = await confirm(t(key, { s: server.name, r: reclaim || '—' }), t('op.pruneOk'))
    if (!ok) return { ok: false, cancelled: true }
    const r = await monitor.execFor(serverId, cmd, 10 * 60_000)
    monitor.refreshServer(serverId)
    const out = (r.stdout + r.stderr).trim()
    const freed = reclaimedSummary(out)
    return {
      ok: r.code === 0,
      output: freed.length ? t('dock.pruned', { v: freed.join(' + ') }) : t('dock.prunedNone'),
      error: r.code === 0 ? undefined : `${t('err.exitCode', { n: r.code })}: ${out.slice(-300)}`
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const CONTAINER_ACTIONS: Record<ContainerAction, { confirm: MsgKey; ok: MsgKey }> = {
  start: { confirm: 'op.startConfirm', ok: 'op.startOk' },
  stop: { confirm: 'op.stopConfirm', ok: 'op.stopOk' },
  restart: { confirm: 'op.restartConfirm', ok: 'dlg.yesRestart' }
}

/** docker start/stop/restart: yalnızca bilinen container, yönetim eylemleri açıkken ve native onaydan sonra. */
export async function containerAction(
  monitor: Monitor,
  serverId: string,
  name: string,
  action: ContainerAction,
  confirm: (message: string, okLabel: string) => Promise<boolean>
): Promise<ActionResult> {
  try {
    if (!monitor.config.settings.allowActions) throw new Error(t('err.actionsDisabled'))
    const def = CONTAINER_ACTIONS[action]
    if (!def) throw new Error(t('err.badAction'))
    safeName(name)
    const server = monitor.config.server(serverId)
    if (!server) throw new Error(t('err.serverNotFound'))
    if (!monitor.state(serverId)?.docker?.containers.some((c) => c.name === name)) throw new Error(t('err.unknownContainer'))
    const ok = await confirm(t(def.confirm, { s: server.name, name }), t(def.ok))
    if (!ok) return { ok: false, cancelled: true }
    const r = await monitor.execFor(serverId, CMD.containerAction(name, action), 90000)
    // Docker durumu beklemeden tazelensin
    monitor.refreshServer(serverId)
    return { ok: r.code === 0, output: (r.stdout + r.stderr).trim(), error: r.code === 0 ? undefined : t('err.exitCode', { n: r.code }) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Prometheus (SSH tüneli: 127.0.0.1:9090)
// ---------------------------------------------------------------------------

const PROM_QUERIES: Record<PromPreset, { q: string; label: (m: Record<string, string>) => string }> = {
  cpu: { q: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)', label: () => 'CPU %' },
  mem: { q: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100', label: () => 'RAM %' },
  disk: {
    q: '(1 - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}) * 100',
    label: () => 'Disk / %'
  },
  net: {
    q: 'sum by (device) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*|tailscale.*"}[5m]))',
    label: (m) => `${m.device ?? 'net'} RX B/s`
  }
}

export async function prometheusQuery(monitor: Monitor, serverId: string, preset: PromPreset, hours: number): Promise<PromResult> {
  try {
    const server = monitor.config.server(serverId)
    if (!server?.prometheus) throw new Error(t('op.promDisabled'))
    const def = PROM_QUERIES[preset]
    if (!def) throw new Error(t('err.unknownQuery'))
    const conn = monitor.connection(serverId)
    if (!conn?.isReady) throw new Error(t('err.sshNotConnected'))
    const h = Math.max(1, Math.min(24 * 30, Math.round(hours)))
    const end = Math.floor(Date.now() / 1000)
    const start = end - h * 3600
    const step = Math.max(60, Math.floor((h * 3600) / 300))
    const qs = new URLSearchParams({ query: def.q, start: String(start), end: String(end), step: String(step) })
    const stream = await conn.forwardOut('127.0.0.1', 9090)
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: 9090,
          path: `/api/v1/query_range?${qs}`,
          method: 'GET',
          createConnection: () => stream as never,
          timeout: 20000
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (d: string) => {
            if (data.length < 8 * 1024 * 1024) data += d
          })
          res.on('end', () => resolve(data))
        }
      )
      req.on('timeout', () => req.destroy(new Error(t('op.promTimeout'))))
      req.on('error', reject)
      req.end()
    })
    const json = JSON.parse(body) as {
      status: string
      error?: string
      data?: { result: { metric: Record<string, string>; values: [number, string][] }[] }
    }
    if (json.status !== 'success') throw new Error(json.error ?? t('op.promError'))
    return {
      ok: true,
      series: (json.data?.result ?? []).map((r) => ({
        label: def.label(r.metric),
        points: r.values.map(([t, v]) => ({ ts: t * 1000, value: Number(v) }))
      }))
    }
  } catch (e) {
    return { ok: false, series: [], error: (e as Error).message }
  }
}
