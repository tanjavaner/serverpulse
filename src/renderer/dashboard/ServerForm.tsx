import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, HostKeyProbe, ServerConfig, ServerInput, SshConfigHost, TestResult } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { Alert, Button, Card, Field, SectionTitle, Toggle } from '../components/ui'
import { SetupCard } from './SetupCard'
import type { Nav } from './App'

export function ServerForm({ server, nav }: { snap: AppSnapshot; server?: ServerConfig; nav: Nav }): ReactNode {
  const [f, setF] = useState<ServerInput>(() => ({
    id: server?.id,
    name: server?.name ?? '',
    host: server?.host ?? '',
    port: server?.port ?? 22,
    username: server?.username ?? '',
    authType: server?.authType ?? 'key',
    agent: server?.agent ?? 'openssh',
    keyFileName: server?.keyFileName,
    hostKeyFingerprint: server?.hostKeyFingerprint,
    systemdUnits: server?.systemdUnits ?? [],
    asterisk: server?.asterisk ?? false,
    prometheus: server?.prometheus ?? false,
    enabled: server?.enabled ?? true,
    maintenance: server?.maintenance,
    password: '',
    passphrase: '',
    privateKeyPath: undefined
  }))
  const [unitsText, setUnitsText] = useState((server?.systemdUnits ?? []).join(', '))
  const [probe, setProbe] = useState<HostKeyProbe | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([])
  // İsteğe bağlı entegrasyonlar (Asterisk, Prometheus) kullanılıyorsa ya da test sunucuda Asterisk bulduysa açık
  const [integrationsOpen, setIntegrationsOpen] = useState(!!(server?.asterisk || server?.prometheus))
  useEffect(() => {
    if (test?.ok && (test.asteriskAccess === 'ok' || test.asteriskAccess === 'no-sudo')) setIntegrationsOpen(true)
  }, [test])
  useEffect(() => {
    if (!server) void api.invoke('server:sshConfigHosts').then(setSshHosts)
  }, [server])

  /** ~/.ssh/config'teki bir Host bloğuyla formu doldurur; host key onayı yine gerekir. */
  const fillFrom = (alias: string): void => {
    const h = sshHosts.find((x) => x.alias === alias)
    if (!h) return
    setProbe(null)
    setTest(null)
    setF((prev) => ({
      ...prev,
      name: prev.name || h.alias,
      host: h.host,
      port: h.port ?? 22,
      username: h.user ?? prev.username,
      hostKeyFingerprint: undefined,
      ...(h.identityFile ? { authType: 'key' as const, privateKeyPath: h.identityFile, keyFileName: h.identityFile.split(/[\\/]/).pop() } : {})
    }))
  }

  const set = <K extends keyof ServerInput>(k: K, v: ServerInput[K]): void => {
    setF((prev) => {
      const next = { ...prev, [k]: v }
      // Host/port değişirse önceki parmak izi onayı geçersiz
      if ((k === 'host' || k === 'port') && v !== prev[k]) next.hostKeyFingerprint = undefined
      return next
    })
    if (k === 'host' || k === 'port') {
      setProbe(null)
      setTest(null)
    }
  }

  const units = (): string[] =>
    unitsText
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/\.service$/, ''))
      .filter(Boolean)

  const input = (fp = f.hostKeyFingerprint): ServerInput => ({ ...f, port: Number(f.port), hostKeyFingerprint: fp, systemdUnits: units() })

  const runTest = async (fp: string): Promise<void> => {
    setBusy('test')
    setTest(null)
    try {
      setTest(await api.invoke('server:test', input(fp)))
    } finally {
      setBusy(null)
    }
  }

  const startTest = async (): Promise<void> => {
    setError(null)
    setTest(null)
    setBusy('test')
    const p = await api.invoke('server:probeHostKey', f.host.trim(), Number(f.port))
    setBusy(null)
    setProbe(p)
    if (!p.ok || !p.fingerprint) return
    if (f.hostKeyFingerprint === p.fingerprint) await runTest(p.fingerprint)
    // Aksi halde kullanıcı onay panelinden onaylayacak
  }

  const confirmKey = async (): Promise<void> => {
    if (!probe?.fingerprint) return
    set('hostKeyFingerprint', probe.fingerprint)
    await runTest(probe.fingerprint)
  }

  const pickKey = async (): Promise<void> => {
    const p = await api.invoke('server:pickKeyFile')
    if (p) setF((prev) => ({ ...prev, privateKeyPath: p, keyFileName: p.split(/[\\/]/).pop() }))
  }

  const save = async (): Promise<void> => {
    setError(null)
    setBusy('save')
    try {
      const saved = await api.invoke('server:save', input())
      nav(server ? { view: 'server', serverId: saved.id } : { view: 'discover', serverId: saved.id })
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!server) return
    await api.invoke('server:remove', server.id)
    nav({ view: 'home' })
  }

  const fpChanged = probe?.fingerprint && server?.hostKeyFingerprint && probe.fingerprint !== server.hostKeyFingerprint
  const needsConfirm = probe?.ok && probe.fingerprint && probe.fingerprint !== f.hostKeyFingerprint

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-bold">{server ? t('common.editTitle', { name: server.name }) : t('sf.addTitle')}</h1>

      <Card className="flex flex-col gap-3">
        <SectionTitle
          right={
            sshHosts.length ? (
              <select className="text-[12px]" value="" onChange={(e) => fillFrom(e.target.value)} title={t('sf.fromSshConfig')}>
                <option value="">{t('sf.fromSshConfig')}</option>
                {sshHosts.map((h) => (
                  <option key={h.alias} value={h.alias}>
                    {h.alias}
                    {h.host !== h.alias ? ` (${h.host})` : ''}
                  </option>
                ))}
              </select>
            ) : null
          }
        >
          {t('sf.connection')}
        </SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('sf.name')}>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={t('sf.namePh')} />
          </Field>
          <Field label={t('sf.user')} hint={t('sf.userHint')}>
            <input value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="deploy" autoComplete="off" />
          </Field>
          <Field label={t('sf.host')} hint={t('sf.hostHint')}>
            <input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder={t('sf.hostPh')} />
          </Field>
          <Field label={t('sf.port')}>
            <input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} min={1} max={65535} />
          </Field>
        </div>

        <div className="flex gap-4 text-[13px]">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.authType === 'key'} onChange={() => set('authType', 'key')} /> {t('sf.authKey')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.authType === 'agent'} onChange={() => set('authType', 'agent')} /> {t('sf.authAgent')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.authType === 'password'} onChange={() => set('authType', 'password')} /> {t('sf.authPassword')}
          </label>
        </div>

        {f.authType === 'key' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('sf.keyFile')} hint={t('sf.keyFileHint')}>
              <div className="flex gap-2">
                <input readOnly value={f.keyFileName ?? ''} placeholder={server?.keyFileName ? t('sf.keySaved') : t('sf.notSelected')} className="flex-1" />
                <Button onClick={() => void pickKey()}>{t('sf.pick')}</Button>
              </div>
            </Field>
            <Field label={t('sf.passphrase')} hint={server ? t('sf.keepSaved') : undefined}>
              <input type="password" value={f.passphrase ?? ''} onChange={(e) => set('passphrase', e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        ) : f.authType === 'agent' ? (
          api.platform === 'win32' ? (
            <Field label={t('sf.agentKind')} hint={t('sf.agentHint')}>
              <select value={f.agent ?? 'openssh'} onChange={(e) => set('agent', e.target.value === 'pageant' ? 'pageant' : 'openssh')} className="max-w-md">
                <option value="openssh">{t('sf.agentOpenssh')}</option>
                <option value="pageant">{t('sf.agentPageant')}</option>
              </select>
            </Field>
          ) : (
            <div className="text-[12px] text-ink-2">{t('sf.agentHint')}</div>
          )
        ) : (
          <Field label={t('sf.authPassword')} hint={server ? t('sf.keepSavedPassword') : t('sf.passwordHint')}>
            <input type="password" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void startTest()} disabled={busy !== null || !f.host || !f.username}>
            {busy === 'test' ? t('sf.testing') : t('sf.test')}
          </Button>
          {f.hostKeyFingerprint ? <span className="font-mono text-[11px] text-muted">{t('sf.approved', { fp: f.hostKeyFingerprint })}</span> : null}
        </div>

        {probe && !probe.ok ? <Alert kind="error">{t('sf.unreachable', { e: probe.error })}</Alert> : null}

        {needsConfirm ? (
          <Alert kind={fpChanged ? 'error' : 'info'}>
            {fpChanged ? (
              <div className="mb-1 font-semibold">{t('sf.keyChanged')}</div>
            ) : (
              <div className="mb-1 font-semibold">{t('sf.firstConnect')}</div>
            )}
            <div className="font-mono text-[12px]">
              {probe?.algorithm} {probe?.fingerprint}
            </div>
            <div className="mt-1 text-[11px] text-ink-2">
              {t('sf.verifyOnServer')} <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
            </div>
            <div className="mt-2">
              <Button small variant="primary" onClick={() => void confirmKey()}>
                {t('sf.confirmFp')}
              </Button>
            </div>
          </Alert>
        ) : null}

        {test ? <TestView r={test} /> : null}
      </Card>

      <SetupCard
        user={f.username.trim()}
        asterisk={!!f.asterisk}
        keySource={
          f.authType !== 'key'
            ? null
            : f.privateKeyPath
              ? { privateKeyPath: f.privateKeyPath, passphrase: f.passphrase || undefined }
              : server?.authType === 'key'
                ? { serverId: server.id, passphrase: f.passphrase || undefined }
                : null
        }
      />

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('sf.monitoring')}</SectionTitle>
        <Field label={t('sf.serverUnits')} hint={t('sf.serverUnitsHint')}>
          <input value={unitsText} onChange={(e) => setUnitsText(e.target.value)} placeholder="nginx, docker, fail2ban, tailscaled" />
        </Field>
        <Toggle checked={f.enabled !== false} onChange={(v) => set('enabled', v)} label={t('sf.enabled')} />
        <details open={integrationsOpen} onToggle={(e) => setIntegrationsOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer text-[13px] text-ink-2">{t('sf.integrations')}</summary>
          <div className="mt-2 flex flex-col gap-3">
            <Toggle checked={!!f.asterisk} onChange={(v) => set('asterisk', v)} label={t('sf.asterisk')} hint={t('sf.asteriskHint')} />
            <Toggle checked={!!f.prometheus} onChange={(v) => set('prometheus', v)} label={t('sf.prometheus')} hint={t('sf.prometheusHint')} />
          </div>
        </details>
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t('sf.maintenance')}</SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('sf.pgContainer')} hint={t('sf.pgContainerHint')}>
            <input
              value={f.maintenance?.pgContainer ?? ''}
              onChange={(e) => set('maintenance', { ...f.maintenance, pgContainer: e.target.value })}
              placeholder="backend-postgres-1"
              autoComplete="off"
            />
          </Field>
          <Field label={t('sf.pgUser')} hint={t('sf.pgUserHint')}>
            <input
              value={f.maintenance?.pgUser ?? ''}
              onChange={(e) => set('maintenance', { ...f.maintenance, pgUser: e.target.value })}
              placeholder="postgres"
              autoComplete="off"
            />
          </Field>
        </div>
      </Card>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null || !f.hostKeyFingerprint || !f.name}>
          {busy === 'save' ? t('common.saving') : server ? t('common.save') : t('sf.saveDiscover')}
        </Button>
        <Button variant="ghost" onClick={() => nav(server ? { view: 'server', serverId: server.id } : { view: 'home' })}>
          {t('common.cancel')}
        </Button>
        {!f.hostKeyFingerprint ? <span className="text-[12px] text-muted">{t('sf.needTest')}</span> : null}
        {server ? (
          <div className="ml-auto">
            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-[12px] text-ink-2">{t('sf.confirmDelete')}</span>
                <Button variant="danger" onClick={() => void remove()}>
                  {t('common.yesDelete')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  {t('common.cancel')}
                </Button>
              </span>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                {t('sf.delete')}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TestView({ r }: { r: TestResult }): ReactNode {
  if (!r.ok) return <Alert kind="error">{t('sf.testFailed', { e: r.error })}</Alert>
  const ast = { ok: t('sf.astOk'), 'no-sudo': t('sf.astNoSudo') }
  return (
    <div className="flex flex-col gap-2">
      <Alert kind="ok">
        <div className="font-semibold">{t('sf.testOk', { ms: r.latencyMs })}</div>
        <div className="font-mono text-[11px] break-all text-ink-2">{r.uname}</div>
        <div className="font-mono text-[11px] break-all text-ink-2">{r.id}</div>
        <div className="mt-1 text-[12px]">
          Docker: {r.dockerAccess ? t('sf.dockerAccess', { v: r.dockerVersion }) : t('sf.noAccess')}
          {/* Asterisk yalnızca sunucuda kuruluysa anılır */}
          {r.asteriskAccess === 'ok' || r.asteriskAccess === 'no-sudo' ? ` · Asterisk CLI: ${ast[r.asteriskAccess]}` : null}
        </div>
      </Alert>
      {r.warnings.map((w) => (
        <Alert key={w} kind="warn">
          {w}
        </Alert>
      ))}
    </div>
  )
}

export function cleanErr(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
