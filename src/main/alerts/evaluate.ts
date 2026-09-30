import type { IssueSeverity, ProjectConfig, ServerConfig, ServerState, Severity, Thresholds } from '@shared/types'

export interface RawIssue {
  key: string
  serverId: string
  projectId?: string
  severity: IssueSeverity
  title: string
  detail?: string
}

const RESTART_WINDOW_MS = 10 * 60 * 1000
/** Reboot/upgrade sırasında erişim ve container alarmlarının en fazla ne kadar susturulacağı. */
export const MAINT_SILENCE_MS = 10 * 60 * 1000

/**
 * Bir sunucunun anlık durumundan açık sorunları üretir. Saf fonksiyondur;
 * debounce ve bildirim AlertEngine'dedir.
 */
export function evaluateServer(
  server: ServerConfig,
  projects: ProjectConfig[],
  st: ServerState | undefined,
  th: Thresholds,
  now: number
): RawIssue[] {
  const issues: RawIssue[] = []
  const sid = server.id
  const add = (key: string, severity: IssueSeverity, title: string, detail?: string, projectId?: string): void => {
    issues.push({ key: `${sid}:${key}`, serverId: sid, projectId, severity, title, detail })
  }
  if (!server.enabled || !st) return issues

  if (st.connection === 'hostkey-mismatch') {
    add('hostkey', 'crit', `${server.name}: host key değişti`, 'Olası MITM. Bağlantı durduruldu; parmak izini ayarlardan yeniden onaylayın.')
    return issues
  }

  // Planlı reboot/upgrade: kesinti beklenen bir durum, alarm üretme
  if (st.maintenance && (st.maintenance.step === 'reboot' || st.maintenance.step === 'upgrade') && now - st.maintenance.since < MAINT_SILENCE_MS) {
    return issues
  }

  if (st.reach && st.reach.consecutiveFailures >= th.unreachableAttempts) {
    add('unreachable', 'crit', `${server.name}: sunucuya erişilemiyor`, st.reach.error)
    // Veri bayat olduğu için diğer kontroller değerlendirilmez
    return issues
  }
  if (st.connection === 'error' && st.connError && /auth|kimlik|All configured authentication methods failed/i.test(st.connError)) {
    add('auth', 'crit', `${server.name}: SSH kimlik doğrulaması başarısız`, st.connError)
  }

  // --- Host ---------------------------------------------------------------
  const h = st.host
  if (h) {
    for (const d of h.disks) {
      if (d.pct >= th.diskPct) {
        add(`disk:${d.mount}`, d.pct >= 95 ? 'crit' : 'warn', `${server.name}: disk ${d.mount} %${d.pct}`, `${fmtBytes(d.avail)} boş`)
      }
    }
    if (h.memHighSince != null && now - h.memHighSince >= th.ramDurationSec * 1000 && h.memPct != null) {
      add('ram', 'warn', `${server.name}: RAM %${Math.round(h.memPct)}`, `${Math.round(th.ramDurationSec / 60)} dakikadan uzun süredir %${th.ramPct} üzerinde`)
    }
  }

  const projectOf = (pred: (p: ProjectConfig) => boolean): string | undefined => projects.find(pred)?.id

  // --- Docker -------------------------------------------------------------
  const dk = st.docker
  if (dk) {
    if (!dk.available) {
      add('docker', 'warn', `${server.name}: Docker okunamıyor`, dk.error)
    } else {
      const byName = new Map(dk.containers.map((c) => [c.name, c]))
      const expected = new Set(projects.flatMap((p) => p.containers))
      // Projelere atanmış container yoksa tüm container'lar izlenir
      const watch = expected.size > 0 ? [...expected] : dk.containers.map((c) => c.name)
      for (const name of watch) {
        const pid = projectOf((p) => p.containers.includes(name))
        const c = byName.get(name)
        if (!c) {
          add(`ctr:${name}:missing`, 'crit', `${name} bulunamadı`, 'Container silinmiş ya da adı değişmiş', pid)
          continue
        }
        if (c.state !== 'running') {
          add(`ctr:${name}:state`, 'crit', `${name} çalışmıyor`, c.status || c.state, pid)
        } else if (c.health === 'unhealthy') {
          add(`ctr:${name}:health`, 'crit', `${name} unhealthy`, c.status, pid)
        }
        if (c.lastRestartIncreaseAt != null && now - c.lastRestartIncreaseAt < RESTART_WINDOW_MS) {
          add(`ctr:${name}:restart`, 'warn', `${name} yeniden başladı`, `Restart sayısı: ${c.restartCount}`, pid)
        }
      }
    }
  }

  // --- systemd ------------------------------------------------------------
  if (st.systemd) {
    for (const u of st.systemd.units) {
      if (u.state !== 'active') {
        const pid = projectOf((p) => p.systemdUnits.includes(u.name))
        add(`unit:${u.name}`, 'crit', `${u.name} servisi ${u.state}`, undefined, pid)
      }
    }
    for (const f of st.systemd.failed) {
      const base = f.replace(/\.service$/, '')
      if (st.systemd.units.some((u) => u.name === base)) continue
      add(`failed:${f}`, 'warn', `Başarısız unit: ${f}`)
    }
  }

  // --- Projeler: HTTP, SSL, Postgres, Asterisk ------------------------------
  const sslSeen = new Set<string>()
  for (const p of projects) {
    for (const c of p.httpChecks) {
      const r = st.http[c.id]
      if (r && !r.ok) {
        add(`http:${c.id}`, 'crit', `${c.name} yanıt vermiyor`, r.error ?? (r.status ? `HTTP ${r.status}` : undefined), p.id)
      }
      if (c.mode === 'public' && c.url?.startsWith('https://')) {
        const host = hostOf(c.url)
        if (!host || sslSeen.has(host)) continue
        sslSeen.add(host)
        const s = st.ssl[host]
        if (!s) continue
        if (s.error && s.daysLeft == null) {
          add(`ssl:${host}`, 'warn', `${host} SSL okunamadı`, s.error, p.id)
        } else if (s.daysLeft != null && s.daysLeft < th.sslDays) {
          add(`ssl:${host}`, s.daysLeft < 3 ? 'crit' : 'warn', `${host} SSL ${Math.max(0, Math.floor(s.daysLeft))} gün içinde bitiyor`, s.validTo, p.id)
        }
      }
    }
    const pg = st.postgres[p.id]
    if (p.postgres && pg && pg.ready === false) {
      add(`pg:${p.id}`, 'crit', `${p.name}: PostgreSQL hazır değil`, pg.error, p.id)
    }
  }

  const ast = st.asterisk
  if (server.asterisk && ast && ast.mode === 'full') {
    const pid = projectOf((p) => p.asterisk)
    for (const r of ast.registrations) {
      if (r.status !== 'Registered') {
        add(`ast:reg:${r.name}`, 'crit', `Asterisk trunk kayıtlı değil: ${r.name}`, r.status, pid)
      }
    }
  }

  return issues
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export function worst(sevs: Severity[]): Severity {
  if (sevs.includes('crit')) return 'crit'
  if (sevs.includes('warn')) return 'warn'
  if (sevs.includes('unknown')) return 'unknown'
  return 'ok'
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}
