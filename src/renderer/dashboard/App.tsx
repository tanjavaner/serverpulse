import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot } from '@shared/types'
import { api, useSnapshot, useTheme } from '../lib/api'
import { projectSeverity, serverSeverity, SEV_LABEL } from '../lib/health'
import { StatusDot } from '../components/ui'
import { ServerView } from './ServerView'
import { ProjectView } from './ProjectView'
import { ServerForm } from './ServerForm'
import { Discovery } from './Discovery'
import { ProjectEditor } from './ProjectEditor'
import { SettingsView } from './SettingsView'
import { EventsView } from './EventsView'

export type Route =
  | { view: 'home' }
  | { view: 'server'; serverId: string }
  | { view: 'project'; serverId: string; projectId: string }
  | { view: 'addServer' }
  | { view: 'editServer'; serverId: string }
  | { view: 'discover'; serverId: string }
  | { view: 'editProject'; serverId: string; projectId?: string }
  | { view: 'settings' }
  | { view: 'events' }

export type Nav = (r: Route) => void

export function App(): ReactNode {
  const snap = useSnapshot()
  useTheme(snap?.settings.theme)
  const [route, setRoute] = useState<Route>(() => {
    const id = new URLSearchParams(location.search).get('server')
    return id ? { view: 'server', serverId: id } : { view: 'home' }
  })

  useEffect(() => api.onNavigate((serverId) => setRoute({ view: 'server', serverId })), [])

  // Ana sayfada ilk sunucuyu göster; sunucu yoksa ekleme formu
  useEffect(() => {
    if (!snap || route.view !== 'home') return
    if (snap.servers.length === 0) setRoute({ view: 'addServer' })
    else setRoute({ view: 'server', serverId: snap.servers[0].id })
  }, [snap, route.view])

  if (!snap) return <div className="flex h-full items-center justify-center text-ink-2">Yükleniyor…</div>

  return (
    <div className="flex h-full bg-page text-ink">
      <Sidebar snap={snap} route={route} nav={setRoute} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1200px] px-6 py-5">
          <Content snap={snap} route={route} nav={setRoute} />
        </div>
      </main>
    </div>
  )
}

function Content({ snap, route, nav }: { snap: AppSnapshot; route: Route; nav: Nav }): ReactNode {
  switch (route.view) {
    case 'server': {
      const s = snap.servers.find((x) => x.id === route.serverId)
      return s ? <ServerView key={s.id} snap={snap} server={s} nav={nav} /> : <NotFound nav={nav} />
    }
    case 'project': {
      const s = snap.servers.find((x) => x.id === route.serverId)
      const p = snap.projects.find((x) => x.id === route.projectId)
      return s && p ? <ProjectView key={p.id} snap={snap} server={s} project={p} nav={nav} /> : <NotFound nav={nav} />
    }
    case 'addServer':
      return <ServerForm key="new" snap={snap} nav={nav} />
    case 'editServer': {
      const s = snap.servers.find((x) => x.id === route.serverId)
      return s ? <ServerForm key={s.id} snap={snap} server={s} nav={nav} /> : <NotFound nav={nav} />
    }
    case 'discover': {
      const s = snap.servers.find((x) => x.id === route.serverId)
      return s ? <Discovery key={s.id} snap={snap} server={s} nav={nav} /> : <NotFound nav={nav} />
    }
    case 'editProject': {
      const s = snap.servers.find((x) => x.id === route.serverId)
      return s ? <ProjectEditor key={`${s.id}:${route.projectId ?? 'new'}`} snap={snap} server={s} projectId={route.projectId} nav={nav} /> : <NotFound nav={nav} />
    }
    case 'settings':
      return <SettingsView snap={snap} />
    case 'events':
      return <EventsView snap={snap} nav={nav} />
    default:
      return null
  }
}

function NotFound({ nav }: { nav: Nav }): ReactNode {
  return (
    <div className="text-ink-2">
      Bulunamadı.{' '}
      <button className="text-accent" onClick={() => nav({ view: 'home' })}>
        Ana sayfaya dön
      </button>
    </div>
  )
}

function Sidebar({ snap, route, nav }: { snap: AppSnapshot; route: Route; nav: Nav }): ReactNode {
  const activeServer = 'serverId' in route ? route.serverId : null
  const activeProject = route.view === 'project' ? route.projectId : null
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-4 py-4">
        <StatusDot sev={snap.overall} size={16} />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold">ServerPulse</span>
          <span className="text-[11px] text-muted">{SEV_LABEL[snap.overall]}</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2">
        <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Sunucular</div>
        {snap.servers.map((s) => {
          const st = snap.states[s.id]
          const projects = snap.projects.filter((p) => p.serverId === s.id)
          return (
            <div key={s.id} className="mb-1">
              <NavItem active={activeServer === s.id && !activeProject && route.view === 'server'} onClick={() => nav({ view: 'server', serverId: s.id })}>
                <StatusDot sev={serverSeverity(s, st, snap.issues)} size={12} />
                <span className="truncate font-medium">{s.name}</span>
              </NavItem>
              {projects.map((p) => (
                <NavItem key={p.id} indent active={activeProject === p.id} onClick={() => nav({ view: 'project', serverId: s.id, projectId: p.id })}>
                  <StatusDot sev={projectSeverity(p, st)} size={10} />
                  <span className="truncate">{p.name}</span>
                </NavItem>
              ))}
            </div>
          )
        })}
        <button className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[13px] text-accent hover:bg-surface-2" onClick={() => nav({ view: 'addServer' })}>
          + Sunucu ekle
        </button>
      </nav>
      <div className="border-t border-line p-2">
        <NavItem active={route.view === 'events'} onClick={() => nav({ view: 'events' })}>
          <span className="w-3 text-center">⚑</span> Olaylar
          {snap.issues.length ? <span className="ml-auto rounded-full bg-critical px-1.5 text-[10px] font-bold text-white">{snap.issues.length}</span> : null}
        </NavItem>
        <NavItem active={route.view === 'settings'} onClick={() => nav({ view: 'settings' })}>
          <span className="w-3 text-center">⚙</span> Ayarlar
        </NavItem>
      </div>
    </aside>
  )
}

function NavItem({ children, active, onClick, indent }: { children: ReactNode; active?: boolean; onClick: () => void; indent?: boolean }): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[13px] ${indent ? 'pr-2 pl-7' : 'px-2'} ${
        active ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
