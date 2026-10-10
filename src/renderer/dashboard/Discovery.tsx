import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, DiscoveryResult, ProjectConfig, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { baseName, commonDir, mergeProjects, mergeSuggestions, slug, uniqueId } from '@shared/projects'
import { api } from '../lib/api'
import { roleLabel } from '../lib/health'
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
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const existing = snap.projects.filter((p) => p.serverId === server.id)
  const suggestions = mergeSuggestions(proposals)

  /** Seçilen önerileri tek projede birleştirir (ilkinin yerine konur). */
  const merge = (ids: string[], name: string): void => {
    setProposals((ps) => {
      const picked = ps.filter((p) => ids.includes(p.id))
      if (picked.length < 2) return ps
      const rest = ps.filter((p) => !ids.includes(p.id))
      const id = uniqueId(`${server.id}-${slug(name)}`, new Set(rest.map((p) => p.id)))
      const merged = { ...mergeProjects(picked, name, id), include: true }
      const at = ps.findIndex((p) => ids.includes(p.id))
      const next = [...ps.filter((p, i) => i < at && !ids.includes(p.id)), merged, ...ps.filter((p, i) => i > at && !ids.includes(p.id))]
      return next
    })
    setMergeSel(new Set())
    setNotice(t('disc.merged', { n: ids.length, name }))
  }

  const mergeSelected = (): void => {
    const picked = proposals.filter((p) => mergeSel.has(p.id))
    const dir = commonDir(picked.map((p) => p.workingDir).filter((d): d is string => !!d))
    merge([...mergeSel], dir ? baseName(dir) : (picked[0]?.name ?? 'project'))
  }

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const r = await api.invoke('server:discover', server.id)
    setLoading(false)
    setRes(r)
    setMergeSel(new Set())
    setNotice(null)
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
      // Aynı id'li ya da aynı container'ları içeren mevcut projeler öneriyle değiştirilir; diğerleri isteğe bağlı korunur
      const ids = new Set(chosen.map((p) => p.id))
      const ctrs = new Set(chosen.flatMap((p) => p.containers))
      const kept = existing.filter((p) => !ids.has(p.id) && !p.containers.some((c) => ctrs.has(c)))
      const merged = keepExisting ? [...kept, ...chosen] : chosen
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
        <h1 className="text-xl font-bold">{t('disc.title', { name: server.name })}</h1>
        <Button onClick={() => void run()} disabled={loading}>
          {loading ? t('disc.scanning') : t('disc.rescan')}
        </Button>
      </div>
      <p className="text-[12px] text-ink-2">
        {t('disc.introBefore')} <code>docker ps</code>, <code>systemctl list-units</code>, <code>ss -tln</code>, <code>/etc/nginx/sites-enabled/*</code>. {t('disc.introAfter')}
      </p>

      {loading && !res ? <div className="text-ink-2">{t('disc.scanningServer')}</div> : null}
      {res && !res.ok ? <Alert kind="error">{res.error}</Alert> : null}

      {res?.ok ? (
        <>
          <div className="text-[12px] text-ink-2">
            {t('disc.found', { c: res.containers.length, d: res.domains.length, list: res.domains.join(', ') || '—', u: res.runningUnits.length })}
          </div>

          {suggestions.map((s) => (
            <Alert key={s.dir} kind="info">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {t('disc.mergeSuggest', {
                    name: s.name,
                    n: s.ids.length,
                    list: proposals
                      .filter((p) => s.ids.includes(p.id))
                      .map((p) => p.name)
                      .join(', ')
                  })}
                </span>
                <Button small variant="primary" onClick={() => merge(s.ids, s.name)}>
                  {t('disc.merge')}
                </Button>
              </div>
            </Alert>
          ))}
          {notice ? <Alert kind="ok">{notice}</Alert> : null}
          {mergeSel.size >= 2 ? (
            <div className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-line bg-surface p-2 shadow">
              <Button small variant="primary" onClick={mergeSelected}>
                {t('disc.mergeSelected', { n: mergeSel.size })}
              </Button>
              <Button small variant="ghost" onClick={() => setMergeSel(new Set())}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {proposals.map((p, i) => (
              <Card key={p.id} className={`flex flex-col gap-2 ${p.include ? '' : 'opacity-50'}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={p.include} onChange={(e) => upd(i, { include: e.target.checked })} />
                  <input className="flex-1 font-semibold" value={p.name} onChange={(e) => upd(i, { name: e.target.value })} />
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2" title={t('disc.mergeSelectHint')}>
                    <input
                      type="checkbox"
                      checked={mergeSel.has(p.id)}
                      onChange={(e) =>
                        setMergeSel((prev) => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(p.id)
                          else n.delete(p.id)
                          return n
                        })
                      }
                    />
                    {t('disc.mergeSelect')}
                  </label>
                </div>
                {p.workingDir ? <div className="font-mono text-[11px] text-muted">{p.workingDir}</div> : null}
                <div className="text-[12px]">
                  <b>{t('disc.containers')}</b>{' '}
                  {p.containers.map((c) => (
                    <span key={c} className="mr-2 inline-block">
                      {c} <span className="text-muted">({roleLabel(p.containerRoles[c] ?? 'other')})</span>
                    </span>
                  ))}
                  {p.containers.length === 0 ? '—' : null}
                </div>
                {p.httpChecks.length ? (
                  <div className="text-[12px]">
                    <b>{t('disc.httpChecks')}</b>
                    <ul className="ml-4 list-disc">
                      {p.httpChecks.map((c) => (
                        <li key={c.id}>
                          {c.mode === 'public' ? c.url : `http://${c.host}:${c.port}${c.path}`} <span className="text-muted">({c.mode === 'public' ? t('disc.fromPc') : t('disc.viaSsh')})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {p.postgres ? (
                  <div className="text-[12px]">
                    <b>PostgreSQL:</b> {t('disc.pgDetail', { c: p.postgres.container, u: p.postgres.user })}
                  </div>
                ) : null}
                {p.systemdUnits.length || p.asterisk ? (
                  <div className="text-[12px]">
                    <b>systemd:</b> {p.systemdUnits.join(', ')}
                    {p.asterisk ? t('disc.asteriskMon') : ''}
                  </div>
                ) : null}
                <div className="text-[11px] text-muted">{t('disc.tuneLater')}</div>
              </Card>
            ))}
          </div>

          <Card className="flex flex-col gap-2">
            <SectionTitle>{t('disc.serverUnits')}</SectionTitle>
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
            {/* Yalnızca Asterisk zaten açıksa ya da keşif çalışan bir asterisk servisi bulduysa */}
            {server.asterisk || proposals.some((p) => p.asterisk) ? <Toggle checked={asterisk} onChange={setAsterisk} label={t('disc.asteriskToggle')} /> : null}
          </Card>

          {existing.length ? (
            <Toggle
              checked={keepExisting}
              onChange={setKeepExisting}
              label={t('disc.keepExisting', { n: existing.length })}
              hint={t('disc.keepHint')}
            />
          ) : null}

          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('common.saving') : t('disc.saveN', { n: proposals.filter((p) => p.include).length })}
            </Button>
            <Button variant="ghost" onClick={() => nav({ view: 'server', serverId: server.id })}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
