import type { AppSnapshot, ComponentRole, ContainerInfo, Issue, ProjectConfig, ServerConfig, ServerState, Severity } from './types'
import { t, type MsgKey } from './i18n'

export function roleLabel(r: ComponentRole): string {
  return t(`role.${r}`)
}

export const ROLE_ORDER: ComponentRole[] = ['backend', 'frontend', 'db', 'asterisk', 'monitoring', 'other']

export function sevLabel(s: Severity): string {
  return t(`sev.${s}`)
}

const CONN_KEY: Record<ServerState['connection'], MsgKey> = {
  idle: 'conn.idle',
  connecting: 'conn.connecting',
  ready: 'conn.ready',
  error: 'conn.error',
  'auth-failed': 'conn.authFailed',
  'hostkey-mismatch': 'conn.hostkeyMismatch',
  disabled: 'conn.disabled'
}

export function connLabel(c: ServerState['connection']): string {
  return t(CONN_KEY[c])
}

const RANK: Record<Severity, number> = { crit: 3, warn: 2, unknown: 1, ok: 0 }

export function worst(list: Severity[]): Severity {
  return list.reduce<Severity>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')
}

export function sevRank(s: Severity): number {
  return RANK[s]
}

export function containerSeverity(docker: ServerState['docker'], name: string): Severity {
  if (!docker || !docker.available) return 'unknown'
  const c = docker.containers.find((x) => x.name === name)
  return containerInfoSeverity(c)
}

export function containerInfoSeverity(c: ContainerInfo | undefined): Severity {
  if (!c) return 'crit'
  if (c.state === 'restarting') return 'warn'
  if (c.state !== 'running' || c.health === 'unhealthy') return 'crit'
  if (c.health === 'starting') return 'warn'
  return 'ok'
}

export function isContainerHealthy(c: ContainerInfo): boolean {
  return containerInfoSeverity(c) === 'ok'
}

/** Proje içinde role göre bileşen rozetleri: canlı durumdan hesaplanır. */
export function projectBadges(p: ProjectConfig, st: ServerState | undefined): { role: ComponentRole; sev: Severity }[] {
  const byRole = new Map<ComponentRole, Severity[]>()
  const push = (r: ComponentRole, s: Severity): void => {
    byRole.set(r, [...(byRole.get(r) ?? []), s])
  }
  for (const name of p.containers) push(p.containerRoles[name] ?? 'other', containerSeverity(st?.docker, name))
  for (const c of p.httpChecks) {
    const r = st?.http[c.id]
    push(c.role, !r ? 'unknown' : r.ok ? 'ok' : 'crit')
  }
  if (p.postgres) {
    const pg = st?.postgres[p.id]
    push('db', !pg || pg.ready == null ? 'unknown' : pg.ready ? 'ok' : 'crit')
  }
  if (p.asterisk) {
    const unit = st?.systemd?.units.find((u) => u.name === 'asterisk')
    push('asterisk', !unit ? 'unknown' : unit.state === 'active' ? 'ok' : 'crit')
    const ast = st?.asterisk
    if (ast?.mode === 'full') push('asterisk', ast.registrations.every((r) => r.status === 'Registered') ? 'ok' : 'crit')
  }
  for (const u of p.systemdUnits) {
    if (u === 'asterisk' && p.asterisk) continue
    const unit = st?.systemd?.units.find((x) => x.name === u)
    push('other', !unit ? 'unknown' : unit.state === 'active' ? 'ok' : 'crit')
  }
  return ROLE_ORDER.filter((r) => byRole.has(r)).map((role) => ({ role, sev: worst(byRole.get(role)!) }))
}

export function projectSeverity(p: ProjectConfig, st: ServerState | undefined): Severity {
  const b = projectBadges(p, st)
  return b.length ? worst(b.map((x) => x.sev)) : 'unknown'
}

/** Sunucu durumu: açık (debounce edilmiş) sorunlar + bağlantı durumu. */
export function serverSeverity(server: ServerConfig, st: ServerState | undefined, issues: Issue[]): Severity {
  if (!server.enabled) return 'unknown'
  const mine = issues.filter((i) => i.serverId === server.id)
  if (mine.length) return worst(mine.map((i) => i.severity))
  if (!st || st.connection !== 'ready' || !st.host) return 'unknown'
  return 'ok'
}

export function rootDisk(st: ServerState | undefined): { pct: number; avail: number } | null {
  const d = st?.host?.disks.find((x) => x.mount === '/') ?? st?.host?.disks[0]
  return d ? { pct: d.pct, avail: d.avail } : null
}

export function containerCounts(st: ServerState | undefined, snap: AppSnapshot, serverId: string): { healthy: number; total: number } | null {
  if (!st?.docker?.available) return null
  const expected = new Set(snap.projects.filter((p) => p.serverId === serverId).flatMap((p) => p.containers))
  const list = expected.size ? [...expected].map((n) => st.docker!.containers.find((c) => c.name === n)) : st.docker.containers
  return { total: list.length, healthy: list.filter((c) => c && isContainerHealthy(c)).length }
}
