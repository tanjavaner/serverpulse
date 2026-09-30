import { useState, type ReactNode } from 'react'
import type { AppSnapshot, ComponentRole, HttpCheck, ProjectConfig, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { ROLE_LABEL, ROLE_ORDER } from '../lib/health'
import { Alert, Button, Card, Field, SectionTitle, Toggle } from '../components/ui'
import { cleanErr } from './ServerForm'
import type { Nav } from './App'

function newId(): string {
  return crypto.randomUUID()
}

export function ProjectEditor({ snap, server, projectId, nav }: { snap: AppSnapshot; server: ServerConfig; projectId?: string; nav: Nav }): ReactNode {
  const others = snap.projects.filter((p) => p.serverId === server.id && p.id !== projectId)
  const original = snap.projects.find((p) => p.id === projectId)
  const [p, setP] = useState<ProjectConfig>(
    () =>
      original ?? {
        id: newId(),
        serverId: server.id,
        name: '',
        containers: [],
        containerRoles: {},
        systemdUnits: [],
        httpChecks: [],
        asterisk: false
      }
  )
  const [unitsText, setUnitsText] = useState(p.systemdUnits.join(', '))
  const [error, setError] = useState<string | null>(null)
  const st = snap.states[server.id]
  const known = [...new Set([...(st?.docker?.containers.map((c) => c.name) ?? []), ...p.containers])].sort()

  const toggleContainer = (name: string, on: boolean): void =>
    setP((prev) => ({
      ...prev,
      containers: on ? [...new Set([...prev.containers, name])] : prev.containers.filter((c) => c !== name),
      containerRoles: on ? { ...prev.containerRoles, [name]: prev.containerRoles[name] ?? 'other' } : prev.containerRoles
    }))

  const updCheck = (id: string, patch: Partial<HttpCheck>): void => setP((prev) => ({ ...prev, httpChecks: prev.httpChecks.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))

  const save = async (): Promise<void> => {
    setError(null)
    try {
      const clean: ProjectConfig = {
        ...p,
        systemdUnits: unitsText
          .split(/[\s,]+/)
          .map((s) => s.replace(/\.service$/, ''))
          .filter(Boolean),
        containerRoles: Object.fromEntries(Object.entries(p.containerRoles).filter(([k]) => p.containers.includes(k)))
      }
      await api.invoke('projects:save', server.id, [...others, clean])
      nav({ view: 'project', serverId: server.id, projectId: clean.id })
    } catch (e) {
      setError(cleanErr(e))
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-bold">{original ? `${original.name}: düzenle` : 'Yeni proje'}</h1>

      <Card className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Proje adı">
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </Field>
        <Field label="Çalışma dizini (bilgi amaçlı)">
          <input value={p.workingDir ?? ''} onChange={(e) => setP({ ...p, workingDir: e.target.value || undefined })} placeholder="/opt/apps/..." />
        </Field>
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionTitle>Container’lar ve rolleri</SectionTitle>
        {known.length === 0 ? <div className="text-[12px] text-muted">Docker verisi yok.</div> : null}
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
          {known.map((name) => {
            const on = p.containers.includes(name)
            return (
              <div key={name} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={on} onChange={(e) => toggleContainer(name, e.target.checked)} />
                <span className="flex-1 truncate">{name}</span>
                <select
                  disabled={!on}
                  value={p.containerRoles[name] ?? 'other'}
                  onChange={(e) => setP({ ...p, containerRoles: { ...p.containerRoles, [name]: e.target.value as ComponentRole } })}
                  className="py-0.5 text-[12px]"
                >
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionTitle
          right={
            <div className="flex gap-2">
              <Button small onClick={() => setP({ ...p, httpChecks: [...p.httpChecks, { id: newId(), name: '', role: 'frontend', mode: 'public', url: 'https://' }] })}>
                + Public URL
              </Button>
              <Button small onClick={() => setP({ ...p, httpChecks: [...p.httpChecks, { id: newId(), name: '', role: 'backend', mode: 'local', host: '127.0.0.1', port: 8080, path: '/health' }] })}>
                + Yerel port (SSH)
              </Button>
            </div>
          }
        >
          HTTP kontrolleri
        </SectionTitle>
        <div className="text-[11px] text-muted">
          Public URL'ler bu bilgisayardan istek atılarak (SSL süresi dahil), yerel portlar SSH üzerinden sunucuda <code>curl</code> ile kontrol edilir. 5xx ya da zaman aşımı hata sayılır.
        </div>
        {p.httpChecks.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[12px]">
            <input className="w-40" placeholder="Ad" value={c.name} onChange={(e) => updCheck(c.id, { name: e.target.value })} />
            <select value={c.role} onChange={(e) => updCheck(c.id, { role: e.target.value as ComponentRole })}>
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {c.mode === 'public' ? (
              <input className="min-w-60 flex-1" value={c.url ?? ''} onChange={(e) => updCheck(c.id, { url: e.target.value })} placeholder="https://ornek.com/health" />
            ) : (
              <>
                <span className="text-muted">http://</span>
                <input className="w-28" value={c.host ?? ''} onChange={(e) => updCheck(c.id, { host: e.target.value })} />
                <span className="text-muted">:</span>
                <input className="w-20" type="number" value={c.port ?? ''} onChange={(e) => updCheck(c.id, { port: Number(e.target.value) })} />
                <input className="w-36" value={c.path ?? '/'} onChange={(e) => updCheck(c.id, { path: e.target.value })} />
              </>
            )}
            <Button small variant="ghost" onClick={() => setP({ ...p, httpChecks: p.httpChecks.filter((x) => x.id !== c.id) })}>
              Sil
            </Button>
          </div>
        ))}
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Veritabanı ve servisler</SectionTitle>
        <Toggle
          checked={!!p.postgres}
          onChange={(v) => setP({ ...p, postgres: v ? { container: p.containers.find((c) => p.containerRoles[c] === 'db') ?? p.containers[0] ?? '', user: 'postgres' } : undefined })}
          label="PostgreSQL kontrolü (pg_isready, bağlantı sayısı, DB boyutları)"
        />
        {p.postgres ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Postgres container">
              <select value={p.postgres.container} onChange={(e) => setP({ ...p, postgres: { ...p.postgres!, container: e.target.value } })}>
                {known.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </Field>
            <Field label="Veritabanı kullanıcısı" hint="docker exec içinde yerel soket ile bağlanılır; şifre gerekmez">
              <input value={p.postgres.user} onChange={(e) => setP({ ...p, postgres: { ...p.postgres!, user: e.target.value } })} />
            </Field>
          </div>
        ) : null}
        <Field label="Projeye ait systemd servisleri" hint="Virgülle ayırın, ör. asterisk">
          <input value={unitsText} onChange={(e) => setUnitsText(e.target.value)} />
        </Field>
        <Toggle checked={p.asterisk} onChange={(v) => setP({ ...p, asterisk: v })} label="Bu projede Asterisk kullanılıyor" hint="Aktif çağrı ve trunk kaydı bu projenin kartında gösterilir." />
      </Card>

      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={!p.name.trim()}>
          Kaydet
        </Button>
        <Button variant="ghost" onClick={() => nav(original ? { view: 'project', serverId: server.id, projectId: original.id } : { view: 'server', serverId: server.id })}>
          Vazgeç
        </Button>
      </div>
    </div>
  )
}
