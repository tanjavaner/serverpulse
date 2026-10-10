import type { ReactNode } from 'react'
import type { AppSnapshot } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { useAsync, useNow } from '../lib/hooks'
import { ago, dateTime } from '../lib/format'
import { sevLabel } from '../lib/health'
import { Card, Empty, SectionTitle, StatusDot } from '../components/ui'
import type { Nav } from './App'

export function EventsView({ snap, nav }: { snap: AppSnapshot; nav: Nav }): ReactNode {
  const now = useNow()
  // Yeni sorun açıldığında/kapandığında listeyi tazele
  const { data } = useAsync(() => api.invoke('events:list', 300), [snap.issues.map((i) => i.key).join('|')], 30_000)
  const name = (id: string): string => snap.servers.find((s) => s.id === id)?.name ?? id

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">{t('nav.events')}</h1>
      <Card>
        <SectionTitle>{t('events.openNow', { n: snap.issues.length })}</SectionTitle>
        {snap.issues.length === 0 ? (
          <div className="text-[13px] text-ink-2">{t('events.noOpen')}</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snap.issues.map((i) => (
              <li key={i.key} className="flex items-center gap-2 text-[13px]">
                <StatusDot sev={i.severity} size={14} />
                <button className="font-medium hover:text-accent" onClick={() => i.serverId && nav({ view: 'server', serverId: i.serverId })}>
                  {i.title}
                </button>
                <span className="truncate text-ink-2">{i.detail}</span>
                <span className="ml-auto shrink-0 text-[11px] text-muted">
                  {name(i.serverId)} · {ago(i.since, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle>{t('events.history30')}</SectionTitle>
        {!data?.length ? (
          <Empty>{t('events.empty')}</Empty>
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="tnum py-1.5 pr-3 whitespace-nowrap text-ink-2">{dateTime(e.ts)}</td>
                  <td className="py-1.5 pr-2">
                    <StatusDot sev={e.kind === 'resolved' ? 'ok' : e.severity} size={12} title={e.kind === 'resolved' ? t('events.resolved') : sevLabel(e.severity)} />
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{e.kind === 'resolved' ? t('events.resolvedPrefix') : ''}{e.title}</span>
                    {e.detail ? <span className="text-ink-2"> · {e.detail}</span> : null}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap text-muted">{name(e.serverId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
