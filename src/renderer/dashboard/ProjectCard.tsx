import type { ReactNode } from 'react'
import type { ProjectConfig, ServerState } from '@shared/types'
import { containerSeverity, projectBadges, projectSeverity, ROLE_LABEL } from '../lib/health'
import { fmtBytes, fmtMs, fmtPct } from '../lib/format'
import { Card, SevBadge, StatusDot } from '../components/ui'

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
            <SevBadge key={b.role} sev={b.sev} label={ROLE_LABEL[b.role]} />
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
                  {r ? (r.status ? `${r.status} · ${fmtMs(r.ms)}` : (r.error ?? 'hata')) : '—'}
                </span>
                {ssl ? (
                  <span
                    className={`tnum shrink-0 rounded px-1 text-[10px] ${ssl.daysLeft != null && ssl.daysLeft < 14 ? 'bg-warning text-black' : 'bg-surface-2 text-ink-2'}`}
                    title={ssl.validTo ? `Bitiş: ${new Date(ssl.validTo).toLocaleDateString('tr-TR')}` : ssl.error}
                  >
                    🔒 {ssl.daysLeft != null ? `${Math.floor(ssl.daysLeft)} gün` : '?'}
                  </span>
                ) : null}
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
                  <td className="py-1 pr-2 text-[11px] text-muted">{c ? c.status : 'bulunamadı'}</td>
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
            {pg ? (pg.ready ? 'hazır' : pg.ready === false ? 'hazır değil' : 'bilinmiyor') : '—'}
            {pg?.connections != null ? ` · ${pg.connections} bağlantı` : ''}
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
              {ast.activeCalls ?? 0} aktif çağrı · {ast.activeChannels ?? 0} kanal · {ast.callsProcessed ?? 0} işlenen
              <div className="mt-1 flex flex-wrap gap-1.5">
                {ast.registrations.map((r) => (
                  <span key={r.name} className="inline-flex items-center gap-1 text-[11px]">
                    <StatusDot sev={r.status === 'Registered' ? 'ok' : 'crit'} size={10} />
                    {r.name.split('/')[0]}: {r.status}
                  </span>
                ))}
                {ast.registrations.length === 0 ? <span className="text-[11px] text-muted">Kayıtlı trunk tanımı yok</span> : null}
              </div>
            </span>
          ) : (
            <span className="text-[11px] text-muted">{ast?.error ?? 'Sadece systemd durumu izleniyor'}</span>
          )}
        </div>
      ) : null}
    </Card>
  )
}
