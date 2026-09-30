import { request } from 'node:http'
import type {
  ActionResult,
  DiscoveryResult,
  HostKeyProbe,
  LogResult,
  PromPreset,
  PromResult,
  ServerInput,
  TestResult
} from '@shared/types'
import type { Monitor } from './monitor'
import { CMD, buildScript, parseSections, safeName } from './ssh/commands'
import { execOn, probeHostKey, withTempConnection } from './ssh/connection'
import { isDockerPermissionError, parseDockerPs } from './parsers/docker'
import { parseNginxSites, parseRunningUnits } from './parsers/misc'
import { buildProposals, isPostgresImage, suggestUnits } from './discovery/proposals'
import { allUnits } from './collectors'

export async function probe(host: string, port: number): Promise<HostKeyProbe> {
  try {
    const r = await probeHostKey(host, port)
    return { ok: true, ...r }
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
    else if (isDockerPermissionError(dockerOut)) res.warnings.push('Kullanıcı docker grubunda değil: sudo usermod -aG docker ' + input.username)
    else res.warnings.push('Docker bulunamadı ya da çalışmıyor: ' + dockerOut.split('\n')[0])

    if (sec.asterisk_bin?.rc !== 0) res.asteriskAccess = 'not-installed'
    else if (sec.asterisk_sudo?.rc === 0) res.asteriskAccess = 'ok'
    else {
      res.asteriskAccess = 'no-sudo'
      if (input.asterisk) {
        res.warnings.push('Asterisk CLI için sudoers kuralı yok; sadece systemd durumu gösterilecek.')
      }
    }
    if (isRoot) res.warnings.push('root ile bağlanıyorsunuz. Salt okunur izleme için docker grubundaki ayrı bir kullanıcı önerilir.')
    if (input.authType === 'password') res.warnings.push('Şifreyle giriş yerine SSH anahtarı önerilir.')
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
    if (isDockerPermissionError(psOut)) return { ...empty, error: "Kullanıcının docker'a erişimi yok" }
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

export async function getLogs(monitor: Monitor, serverId: string, kind: 'container' | 'unit', name: string): Promise<LogResult> {
  try {
    safeName(name)
    const server = monitor.config.server(serverId)
    if (!server) throw new Error('Sunucu bulunamadı')
    // Sadece bilinen (keşfedilmiş/yapılandırılmış) adlar için log okunur
    if (kind === 'container') {
      const known = monitor.state(serverId)?.docker?.containers.some((c) => c.name === name)
      if (!known) throw new Error('Bilinmeyen container')
      const r = await monitor.execFor(serverId, CMD.containerLogs(name), 20000)
      return { ok: r.code === 0, lines: r.stdout + r.stderr }
    }
    if (!allUnits(server, monitor.config.projectsOf(serverId)).includes(name)) throw new Error('Bilinmeyen unit')
    const r = await monitor.execFor(serverId, CMD.unitLogs(name), 20000)
    const out = r.stdout + r.stderr
    if (/No journal files were found|not seeing messages from other users/i.test(out)) {
      return { ok: false, lines: out, error: 'Journal okunamıyor; kullanıcı systemd-journal ya da adm grubunda olmalı' }
    }
    return { ok: r.code === 0, lines: out }
  } catch (e) {
    return { ok: false, lines: '', error: (e as Error).message }
  }
}

export async function restartContainer(
  monitor: Monitor,
  serverId: string,
  name: string,
  confirm: (message: string) => Promise<boolean>
): Promise<ActionResult> {
  try {
    if (!monitor.config.settings.allowActions) throw new Error('Yönetim eylemleri ayarlardan kapalı')
    safeName(name)
    const server = monitor.config.server(serverId)
    if (!server) throw new Error('Sunucu bulunamadı')
    if (!monitor.state(serverId)?.docker?.containers.some((c) => c.name === name)) throw new Error('Bilinmeyen container')
    const ok = await confirm(`${server.name} üzerinde "${name}" container'ı yeniden başlatılsın mı?`)
    if (!ok) return { ok: false, cancelled: true }
    const r = await monitor.execFor(serverId, CMD.restartContainer(name), 90000)
    return { ok: r.code === 0, output: (r.stdout + r.stderr).trim(), error: r.code === 0 ? undefined : `Çıkış kodu ${r.code}` }
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
    if (!server?.prometheus) throw new Error('Bu sunucu için Prometheus kapalı')
    const def = PROM_QUERIES[preset]
    if (!def) throw new Error('Bilinmeyen sorgu')
    const conn = monitor.connection(serverId)
    if (!conn?.isReady) throw new Error('SSH bağlı değil')
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
      req.on('timeout', () => req.destroy(new Error('Prometheus zaman aşımı')))
      req.on('error', reject)
      req.end()
    })
    const json = JSON.parse(body) as {
      status: string
      error?: string
      data?: { result: { metric: Record<string, string>; values: [number, string][] }[] }
    }
    if (json.status !== 'success') throw new Error(json.error ?? 'Prometheus hatası')
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
