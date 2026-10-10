import type { AppSnapshot, Severity } from '@shared/types'
import { t } from '@shared/i18n'
import { ago, dateTime, fmtPct } from '@shared/format'
import { connLabel, containerCounts, rootDisk, serverSeverity, sevRank } from '@shared/health'

/** Telegram'ın tek mesaj sınırı 4096 karakter; biraz pay bırakılır. */
const MAX_LEN = 3900
const MAX_ISSUES = 10
const ICON: Record<Severity, string> = { ok: '🟢', warn: '🟠', crit: '🔴', unknown: '⚪' }

function clip(text: string): string {
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text
}

/** Açık sorunların listesi (sunucu adıyla); yoksa "açık sorun yok". */
export function issuesText(snap: AppSnapshot): string {
  if (!snap.issues.length) return t('sum.noIssues')
  const name = (id: string): string => snap.servers.find((s) => s.id === id)?.name ?? ''
  const lines = snap.issues.slice(0, MAX_ISSUES).map((i) => {
    const where = name(i.serverId)
    return `${i.severity === 'crit' ? '🔴' : '🟠'} ${i.title}${i.detail ? ` — ${i.detail}` : ''}${where && !i.title.includes(where) ? ` (${where})` : ''}`
  })
  if (snap.issues.length > MAX_ISSUES) lines.push(t('sum.more', { n: snap.issues.length - MAX_ISSUES }))
  return clip([t('sum.issues', { n: snap.issues.length }), ...lines].join('\n'))
}

/**
 * /durum ve günlük özet: sunucu başına tek satır (durum, CPU/RAM/disk, container sağlığı), açık sorunlar,
 * en yakın SSL bitişi ve son yedekler.
 */
export function statusText(snap: AppSnapshot, now: number, lastBackupAt?: (serverId: string) => number | undefined): string {
  const lines = [t('sum.title', { d: dateTime(now) }), '']
  const rows = snap.servers
    .map((s) => ({ s, st: snap.states[s.id], sev: serverSeverity(s, snap.states[s.id], snap.issues) }))
    .sort((a, b) => sevRank(b.sev) - sevRank(a.sev) || a.s.name.localeCompare(b.s.name))
  for (const { s, st, sev } of rows) {
    const h = st?.host
    let detail: string
    if (!s.enabled) detail = connLabel('disabled')
    else if (st?.connection === 'ready' && h) {
      const disk = rootDisk(st)
      const counts = containerCounts(st, snap, s.id)
      detail = [
        `CPU ${fmtPct(h.cpuPct)}`,
        `RAM ${fmtPct(h.memPct)}`,
        `Disk ${fmtPct(disk?.pct)}`,
        counts ? t('sum.containers', { h: counts.healthy, n: counts.total }) : ''
      ]
        .filter(Boolean)
        .join(' · ')
    } else detail = connLabel(st?.connection ?? 'idle')
    lines.push(`${ICON[sev]} ${s.name} — ${detail}`)
  }
  if (!rows.length) lines.push(t('widget.noServers'))

  lines.push('', issuesText(snap))

  // En yakın SSL bitişi (tüm sunuculardaki public kontrollerden)
  let nearest: { host: string; days: number } | null = null
  for (const st of Object.values(snap.states)) {
    for (const ssl of Object.values(st.ssl)) {
      if (ssl.daysLeft != null && (!nearest || ssl.daysLeft < nearest.days)) nearest = { host: ssl.host, days: ssl.daysLeft }
    }
  }
  const extra: string[] = []
  if (nearest) extra.push(t('sum.ssl', { h: nearest.host, n: Math.max(0, Math.floor(nearest.days)) }))
  for (const { s } of rows) {
    const at = lastBackupAt?.(s.id)
    if (at) extra.push(t('sum.backup', { s: s.name, a: ago(at, now) }))
  }
  if (extra.length) lines.push('', ...extra)
  return clip(lines.join('\n'))
}

export function helpText(): string {
  return t('sum.help')
}
