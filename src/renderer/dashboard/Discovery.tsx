import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, DiscoveryResult, ProjectConfig, ServerConfig } from '@shared/types'
import { api } from '../lib/api'
import { ROLE_LABEL } from '../lib/health'
import { Alert, Button, Card, SectionTitle, Toggle } from '../components/ui'
import { cleanErr } from './ServerForm'
import type { Nav } from './App'

export function Discovery({ snap, server, nav }: { snap: AppSnapshot; server: ServerConfig; nav: Nav }): ReactNode {
  const [res, setRes] = useState<DiscoveryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [proposals, setProposals] = useState<(ProjectConfig & { include: boolean })[]>([])
  const [units, setUnits] = useState<Set<string>>(new Set(server.systemdUnits))
  const [asterisk, setAsterisk] = useState(server.asterisk)
  const [keepExisting, setKeepExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const existing = snap.projects.filter((p) => p.serverId === server.id)

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const r = await api.invoke('server:discover', server.id)
    setLoading(false)
    setRes(r)
    if (!r.ok) return
    setProposals(r.proposals.map((p) => ({ ...p, include: true })))
    setUnits((prev) => new Set([...prev, ...r.suggestedUnits]))
    if (r.proposals.some((p) => p.asterisk)) setAsterisk(true)
  }

  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const chosen = proposals.filter((p) => p.include).map(({ include: _i, ...p }) => p)
      // Aynı id'li (aynı ada sahip) mevcut projeler öneriyle değiştirilir; diğerleri isteğe bağlı korunur
      const ids = new Set(chosen.map((p) => p.id))
      const merged = keepExisting ? [...existing.filter((p) => !ids.has(p.id)), ...chosen] : chosen
      await api.invoke('server:update', server.id, { systemdUnits: [...units], asterisk })
      await api.invoke('projects:save', server.id, merged)
      nav({ view: 'server', serverId: server.id })
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setSaving(false)
    }
  }

  const upd = (i: number, patch: Partial<ProjectConfig & { include: boolean }>): void =>
    setProposals((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">{server.name}: keşif</h1>
        <Button onClick={() => void run()} disabled={loading}>
          {loading ? 'Taranıyor…' : '↻ Yeniden tara'}
        </Button>
      </div>
      <p className="text-[12px] text-ink-2">
        Salt okunur komutlar çalıştırılır: <code>docker ps</code>, <code>systemctl list-units</code>, <code>ss -tln</code> ve <code>/etc/nginx/sites-enabled/*</code>. Sunucuda hiçbir şey değiştirilmez.
      </p>

      {loading && !res ? <div className="text-ink-2">Sunucu taranıyor…</div> : null}
      {res && !res.ok ? <Alert kind="error">{res.error}</Alert> : null}

      {res?.ok ? (
        <>
          <div className="text-[12px] text-ink-2">
            {res.containers.length} container, {res.domains.length} domain ({res.domains.join(', ') || '—'}), {res.runningUnits.length} çalışan servis bulundu.
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {proposals.map((p, i) => (
              <Card key={p.id} className={`flex flex-col gap-2 ${p.include ? '' : 'opacity-50'}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={p.include} onChange={(e) => upd(i, { include: e.target.checked })} />
                  <input className="flex-1 font-semibold" value={p.name} onChange={(e) => upd(i, { name: e.target.value })} />
                </div>
                {p.workingDir ? <div className="font-mono text-[11px] text-muted">{p.workingDir}</div> : null}
                <div className="text-[12px]">
                  <b>Container’lar:</b>{' '}
                  {p.containers.map((c) => (
                    <span key={c} className="mr-2 inline-block">
                      {c} <span className="text-muted">({ROLE_LABEL[p.containerRoles[c] ?? 'other']})</span>
                    </span>
                  ))}
                  {p.containers.length === 0 ? '—' : null}
                </div>
                {p.httpChecks.length ? (
                  <div className="text-[12px]">
                    <b>HTTP kontrolleri:</b>
                    <ul className="ml-4 list-disc">
                      {p.httpChecks.map((c) => (
                        <li key={c.id}>
                          {c.mode === 'public' ? c.url : `http://${c.host}:${c.port}${c.path}`} <span className="text-muted">({c.mode === 'public' ? 'PC’den' : 'SSH ile'})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {p.postgres ? (
                  <div className="text-[12px]">
                    <b>PostgreSQL:</b> {p.postgres.container} (kullanıcı: {p.postgres.user})
                  </div>
                ) : null}
                {p.systemdUnits.length || p.asterisk ? (
                  <div className="text-[12px]">
                    <b>systemd:</b> {p.systemdUnits.join(', ')}
                    {p.asterisk ? ' · Asterisk izleme' : ''}
                  </div>
                ) : null}
                <div className="text-[11px] text-muted">Kaydettikten sonra projeyi “Düzenle” ile ince ayar yapabilirsiniz (health path, roller vb.).</div>
              </Card>
            ))}
          </div>

          <Card className="flex flex-col gap-2">
            <SectionTitle>Sunucu seviyesinde izlenecek servisler</SectionTitle>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {[...new Set([...res.runningUnits, ...units])].sort().map((u) => (
                <label key={u} className={`flex items-center gap-1.5 text-[12px] ${res.suggestedUnits.includes(u) ? 'font-medium' : 'text-ink-2'}`}>
                  <input
                    type="checkbox"
                    checked={units.has(u)}
                    onChange={(e) =>
                      setUnits((prev) => {
                        const n = new Set(prev)
                        if (e.target.checked) n.add(u)
                        else n.delete(u)
                        return n
                      })
                    }
                  />
                  {u}
                </label>
              ))}
            </div>
            <Toggle checked={asterisk} onChange={setAsterisk} label="Asterisk CLI okumaları (aktif çağrı, trunk kaydı)" />
          </Card>

          {existing.length ? (
            <Toggle
              checked={keepExisting}
              onChange={setKeepExisting}
              label={`Mevcut ${existing.length} projeyi koru`}
              hint="Aynı ada sahip projeler yeni öneriyle değiştirilir. Kapalıysa tüm projeler seçilen önerilerle değiştirilir."
            />
          ) : null}

          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Kaydediliyor…' : `Seçilen ${proposals.filter((p) => p.include).length} projeyi kaydet`}
            </Button>
            <Button variant="ghost" onClick={() => nav({ view: 'server', serverId: server.id })}>
              Vazgeç
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
