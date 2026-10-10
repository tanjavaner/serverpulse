import type { ReactNode } from 'react'
import type { ProjectConfig, ServerState, Uptime } from '@shared/types'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { t } from '@shared/i18n'
import { containerSeverity, projectBadges, projectSeverity, roleLabel } from '../lib/health'
import { dateOnly, fmtBytes, fmtMs, fmtPct } from '../lib/format'
import { Card, SevBadge, StatusDot } from '../components/ui'

/** Son 24 saatin uptime'ı; üzerine gelince 7 ve 30 gün. %99.9 altı sarı, %99 altı kırmızı. */
function UptimeBadge({ u }: { u: Uptime | undefined }): ReactNode {
  if (!u || u.d1 == null) return null
  const color = u.d1 >= 99.9 ? 'text-good' : u.d1 >= 99 ? 'text-warning' : 'text-critical'
  const fmt = (v: number | null): string => (v == null ? '—' : fmtPct(v, v === 100 ? 0 : 2))
  return (
    <span
      className={`tnum shrink-0 text-[10px] ${color}`}
      title={`${t('uptime.title')}\n${t('uptime.d1')}: ${fmt(u.d1)} · ${t('uptime.d7')}: ${fmt(u.d7)} · ${t('uptime.d30')}: ${fmt(u.d30)}`}
    >
      ↑{fmt(u.d1)}
    </span>
  )
}

function hostOf(url?: string): string | null {
  try {
    return url ? new URL(url).hostname : null
  } catch {
    return null
  }
}

export function ProjectCard({ project, st, onOpen, onLogs }: { project: ProjectConfig; st: ServerState | undefined; onOpen?: () => void; onLogs?: (container: string) => void }): ReactNode {
  const badges = projectBadges(project, st)
  const sev = projectSeverity(project, st)
  const pg = st?.postgres[project.id]
  const ast = project.asterisk ? st?.asterisk : undefined
  const checkIds = project.httpChecks.map((c) => c.id)
  const uptime = useAsync(() => api.invoke('history:uptime', checkIds), [checkIds.join(',')], 5 * 60_000).data

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <StatusDot sev={sev} size={16} />
        <div className="min-w-0 flex-1">
          <button className="truncate text-left text-[15px] font-semibold hover:text-accent" onClick={onOpen} disabled={!onOpen}>
            {project.name}
          </button>
          {project.workingDir ? <div className="truncate font-mono text-[11px] text-muted">{project.workingDir}</div> : null}
        </div>
      </div>

      {badges.length ? (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((b) => (
            <SevBadge key={b.role} sev={b.sev} label={roleLabel(b.role)} />
          ))}
        </div>
      ) : null}

      {project.httpChecks.length ? (
        <div className="flex flex-col gap-1">
          {project.httpChecks.map((c) => {
            const r = st?.http[c.id]
            const host = c.mode === 'public' ? hostOf(c.url) : null
            const ssl = host ? st?.ssl[host] : undefined
            return (
              <div key={c.id} className="flex items-center gap-2 text-[12px]">
                <StatusDot sev={!r ? 'unknown' : r.ok ? 'ok' : 'crit'} size={10} />
                {c.mode === 'public' && c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="truncate hover:text-accent hover:underline">
                    {c.name}
                  </a>
                ) : (
                  <span className="truncate">{c.name}</span>
                )}
                <span className="text-[10px] text-muted">{c.mode === 'public' ? 'PC→' : 'SSH'}</span>
                <span className="tnum ml-auto shrink-0 text-ink-2">
                  {r ? (r.status ? `${r.status} · ${fmtMs(r.ms)}` : (r.error ?? t('common.error'))) : '—'}
                </span>
                {ssl ? (
                  <span
                    className={`tnum shrink-0 rounded px-1 text-[10px] ${ssl.daysLeft != null && ssl.daysLeft < 14 ? 'bg-warning text-black' : 'bg-surface-2 text-ink-2'}`}
                    title={ssl.validTo ? t('project.sslExpires', { d: dateOnly(ssl.validTo) }) : ssl.error}
                  >
                    🔒 {ssl.daysLeft != null ? t('fmt.days', { n: Math.floor(ssl.daysLeft) }) : '?'}
                  </span>
                ) : null}
                <UptimeBadge u={uptime?.[c.id]} />
              </div>
            )
          })}
        </div>
      ) : null}

      {project.containers.length ? (
        <table className="w-full text-[12px]">
          <tbody>
            {project.containers.map((name) => {
              const c = st?.docker?.containers.find((x) => x.name === name)
              return (
                <tr key={name} className="border-t border-line">
                  <td className="py-1 pr-2">
                    <span className="flex items-center gap-1.5">
                      <StatusDot sev={containerSeverity(st?.docker, name)} size={10} />
                      <span className="truncate">{name}</span>
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-[11px] text-muted">{c ? c.status : t('project.ctrNotFound')}</td>
                  <td className="tnum py-1 pr-2 text-right text-ink-2">{fmtPct(c?.cpuPct, 1)}</td>
                  <td className="tnum py-1 text-right text-ink-2">{fmtBytes(c?.memBytes)}</td>
                  {onLogs ? (
                    <td className="py-1 pl-2 text-right">
                      <button className="text-[11px] text-accent hover:underline" onClick={() => onLogs(name)}>
                        log
                      </button>
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}

      {project.postgres ? (
        <div className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px]">
          <span className="font-medium">PostgreSQL</span>{' '}
          <span className="text-ink-2">
            {pg ? (pg.ready ? t('project.pgReady') : pg.ready === false ? t('project.pgNotReady') : t('common.unknown')) : '—'}
            {pg?.connections != null ? t('project.pgConns', { n: pg.connections }) : ''}
            {pg?.databases.length ? ` · ${pg.databases.map((d) => `${d.name} ${fmtBytes(d.size)}`).join(', ')}` : ''}
          </span>
          {pg?.error ? <div className="text-[11px] text-critical">{pg.error}</div> : null}
        </div>
      ) : null}

      {project.asterisk ? (
        <div className="rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px]">
          <span className="font-medium">Asterisk</span>{' '}
          {ast?.mode === 'full' ? (
            <span className="text-ink-2">
              {t('project.astSummary', { calls: ast.activeCalls ?? 0, ch: ast.activeChannels ?? 0, proc: ast.callsProcessed ?? 0 })}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {ast.registrations.map((r) => (
                  <span key={r.name} className="inline-flex items-center gap-1 text-[11px]">
                    <StatusDot sev={r.status === 'Registered' ? 'ok' : 'crit'} size={10} />
                    {r.name.split('/')[0]}: {r.status}
                  </span>
                ))}
                {ast.registrations.length === 0 ? <span className="text-[11px] text-muted">{t('project.astNoTrunks')}</span> : null}
              </div>
            </span>
          ) : (
            <span className="text-[11px] text-muted">{ast?.error ?? t('project.astSystemdOnly')}</span>
          )}
        </div>
      ) : null}
    </Card>
  )
}
