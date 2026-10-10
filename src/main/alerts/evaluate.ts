import type { IssueSeverity, MaintStep, ProjectConfig, ServerConfig, ServerState, Severity, Thresholds } from '@shared/types'
import { t } from '@shared/i18n'
import { fmtBytes } from '@shared/format'
import { isPublicBind } from '../parsers/insight'

const pct = (v: number): string => t('fmt.pct', { v })

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
const SILENCING_STEPS = new Set<MaintStep>(['reboot', 'upgrade', 'deploy'])

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
    add('hostkey', 'crit', t('alert.hostkey', { s: server.name }), t('alert.hostkeyDetail'))
    return issues
  }

  // Planlı reboot/upgrade/deploy: kesinti beklenen bir durum, alarm üretme
  if (st.maintenance && SILENCING_STEPS.has(st.maintenance.step) && now - st.maintenance.since < MAINT_SILENCE_MS) {
    return issues
  }

  if (st.connection === 'auth-failed') {
    // Otomatik yeniden deneme yapılmaz; kullanıcı kimlik bilgisini güncellemeli. Veri bayat olduğu için başka kontrol yok.
    add('auth', 'crit', t('alert.auth', { s: server.name }), t('alert.authDetail'))
    return issues
  }

  if (st.reach && st.reach.consecutiveFailures >= th.unreachableAttempts) {
    add('unreachable', 'crit', t('alert.unreachable', { s: server.name }), st.reach.error)
    // Veri bayat olduğu için diğer kontroller değerlendirilmez
    return issues
  }

  // --- Host ---------------------------------------------------------------
  const h = st.host
  if (h) {
    for (const d of h.disks) {
      if (d.pct >= th.diskPct) {
        add(`disk:${d.mount}`, d.pct >= 95 ? 'crit' : 'warn', t('alert.disk', { s: server.name, m: d.mount, pct: pct(d.pct) }), t('server.free', { v: fmtBytes(d.avail) }))
      }
    }
    if (h.memHighSince != null && now - h.memHighSince >= th.ramDurationSec * 1000 && h.memPct != null) {
      add('ram', 'warn', t('alert.ram', { s: server.name, pct: pct(Math.round(h.memPct)) }), t('alert.ramDetail', { min: Math.round(th.ramDurationSec / 60), pct: pct(th.ramPct) }))
    }
  }

  // --- Depolama ve güvenlik (yavaş toplayıcılar) ------------------------------
  for (const i of st.storage?.inodes ?? []) {
    if (i.pct >= th.diskPct) {
      add(`inode:${i.mount}`, i.pct >= 95 ? 'crit' : 'warn', t('alert.inode', { s: server.name, m: i.mount, pct: pct(i.pct) }), t('alert.inodeDetail'))
    }
  }
  if (st.security && server.portBaseline) {
    for (const p of st.security.ports) {
      if (server.portBaseline.includes(p)) continue
      add(`port:${p}`, 'warn', t(isPublicBind(p) ? 'alert.newPortPublic' : 'alert.newPort', { s: server.name, p }), t('alert.newPortDetail'))
    }
  }

  const projectOf = (pred: (p: ProjectConfig) => boolean): string | undefined => projects.find(pred)?.id

  // --- Docker -------------------------------------------------------------
  const dk = st.docker
  if (dk) {
    if (!dk.available) {
      add('docker', 'warn', t('alert.docker', { s: server.name }), dk.error)
    } else {
      const byName = new Map(dk.containers.map((c) => [c.name, c]))
      const expected = new Set(projects.flatMap((p) => p.containers))
      // Projelere atanmış container yoksa tüm container'lar izlenir; ama hiç başlamamış ya da
      // normal biçimde bitmiş (Exited (0)) tek seferlik container'lar alarm üretmez.
      const watch = expected.size > 0 ? [...expected] : dk.containers.filter((c) => !isFinishedNormally(c)).map((c) => c.name)
      for (const name of watch) {
        const pid = projectOf((p) => p.containers.includes(name))
        const c = byName.get(name)
        if (!c) {
          add(`ctr:${name}:missing`, 'crit', t('alert.ctrMissing', { n: name }), t('alert.ctrMissingDetail'), pid)
          continue
        }
        if (c.state !== 'running') {
          add(`ctr:${name}:state`, 'crit', t('alert.ctrDown', { n: name }), c.status || c.state, pid)
        } else if (c.health === 'unhealthy') {
          add(`ctr:${name}:health`, 'crit', t('alert.ctrUnhealthy', { n: name }), c.status, pid)
        }
        if (c.lastRestartIncreaseAt != null && now - c.lastRestartIncreaseAt < RESTART_WINDOW_MS) {
          add(`ctr:${name}:restart`, 'warn', t('alert.ctrRestarted', { n: name }), t('alert.restartCount', { n: c.restartCount }), pid)
        }
      }
    }
  }

  // --- systemd ------------------------------------------------------------
  if (st.systemd) {
    for (const u of st.systemd.units) {
      if (u.state !== 'active') {
        const pid = projectOf((p) => p.systemdUnits.includes(u.name))
        add(`unit:${u.name}`, 'crit', t('alert.unitDown', { n: u.name, state: u.state }), undefined, pid)
      }
    }
    for (const f of st.systemd.failed) {
      const base = f.replace(/\.service$/, '')
      if (st.systemd.units.some((u) => u.name === base)) continue
      add(`failed:${f}`, 'warn', t('alert.failedUnit', { u: f }))
    }
  }

  // --- Projeler: HTTP, SSL, Postgres, Asterisk ------------------------------
  const sslSeen = new Set<string>()
  for (const p of projects) {
    for (const c of p.httpChecks) {
      const r = st.http[c.id]
      // Kontroller 30 sn'de bir çalıştığı için tek bir başarısız istek debounce'u aşar; ardışık hata sayısı beklenir
      if (r && !r.ok && (r.failures ?? 1) >= th.checkFailAttempts) {
        add(`http:${c.id}`, 'crit', t('alert.httpDown', { n: c.name }), r.error ?? (r.status ? `HTTP ${r.status}` : undefined), p.id)
      }
      if (r?.ok && c.slowMs && (r.slowStreak ?? 0) >= th.checkFailAttempts) {
        add(`http:${c.id}:slow`, 'warn', t('alert.httpSlow', { n: c.name }), t('alert.httpSlowDetail', { ms: r.ms, limit: c.slowMs }), p.id)
      }
      if (c.mode === 'public' && c.url?.startsWith('https://')) {
        const host = hostOf(c.url)
        if (!host || sslSeen.has(host)) continue
        sslSeen.add(host)
        const s = st.ssl[host]
        if (!s) continue
        if (s.error && s.daysLeft == null) {
          add(`ssl:${host}`, 'warn', t('alert.sslUnreadable', { h: host }), s.error, p.id)
        } else if (s.daysLeft != null && s.daysLeft < th.sslDays) {
          add(`ssl:${host}`, s.daysLeft < 3 ? 'crit' : 'warn', t('alert.sslExpiring', { h: host, n: Math.max(0, Math.floor(s.daysLeft)) }), s.validTo, p.id)
        }
      }
    }
    const pg = st.postgres[p.id]
    if (p.postgres && pg && pg.ready === false && (pg.failures ?? 1) >= th.checkFailAttempts) {
      add(`pg:${p.id}`, 'crit', t('alert.pgDown', { p: p.name }), pg.error, p.id)
    }
  }

  const ast = st.asterisk
  if (server.asterisk && ast && ast.mode === 'full') {
    const pid = projectOf((p) => p.asterisk)
    for (const r of ast.registrations) {
      if (r.status !== 'Registered') {
        add(`ast:reg:${r.name}`, 'crit', t('alert.trunk', { n: r.name }), r.status, pid)
      }
    }
  }

  return issues
}

/** Hiç başlatılmamış ya da 0 koduyla bitmiş container (migration, certbot vb. tek seferlik işler). */
export function isFinishedNormally(c: { state: string; status: string }): boolean {
  return c.state === 'created' || (c.state === 'exited' && /^Exited \(0\)/.test(c.status))
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
