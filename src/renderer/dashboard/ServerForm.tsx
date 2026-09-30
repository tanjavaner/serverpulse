import { useState, type ReactNode } from 'react'
import type { AppSnapshot, HostKeyProbe, ServerConfig, ServerInput, TestResult } from '@shared/types'
import { api } from '../lib/api'
import { Alert, Button, Card, Field, SectionTitle, Toggle } from '../components/ui'
import type { Nav } from './App'

export function ServerForm({ server, nav }: { snap: AppSnapshot; server?: ServerConfig; nav: Nav }): ReactNode {
  const [f, setF] = useState<ServerInput>(() => ({
    id: server?.id,
    name: server?.name ?? '',
    host: server?.host ?? '',
    port: server?.port ?? 22,
    username: server?.username ?? '',
    authType: server?.authType ?? 'key',
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
      <h1 className="text-xl font-bold">{server ? `${server.name}: düzenle` : 'Sunucu ekle'}</h1>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Bağlantı</SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Ad">
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="ör. Ana VDS" />
          </Field>
          <Field label="Kullanıcı" hint="docker grubunda, root olmayan bir kullanıcı önerilir">
            <input value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="deploy" autoComplete="off" />
          </Field>
          <Field label="Host / IP" hint="Mümkünse Tailscale IP'si (100.x.y.z)">
            <input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="100.99.9.0" />
          </Field>
          <Field label="Port">
            <input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} min={1} max={65535} />
          </Field>
        </div>

        <div className="flex gap-4 text-[13px]">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.authType === 'key'} onChange={() => set('authType', 'key')} /> Özel anahtar (önerilir)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.authType === 'password'} onChange={() => set('authType', 'password')} /> Şifre
          </label>
        </div>

        {f.authType === 'key' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Özel anahtar dosyası" hint="İçerik işletim sisteminin güvenli deposuyla şifrelenip saklanır">
              <div className="flex gap-2">
                <input readOnly value={f.keyFileName ?? ''} placeholder={server?.keyFileName ? '(kayıtlı)' : 'Seçilmedi'} className="flex-1" />
                <Button onClick={() => void pickKey()}>Seç…</Button>
              </div>
            </Field>
            <Field label="Passphrase (varsa)" hint={server ? 'Boş bırakırsanız kayıtlı değer korunur' : undefined}>
              <input type="password" value={f.passphrase ?? ''} onChange={(e) => set('passphrase', e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        ) : (
          <Field label="Şifre" hint={server ? 'Boş bırakırsanız kayıtlı şifre korunur' : 'Şifreli giriş yerine SSH anahtarı önerilir'}>
            <input type="password" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void startTest()} disabled={busy !== null || !f.host || !f.username}>
            {busy === 'test' ? 'Test ediliyor…' : 'Bağlantıyı test et'}
          </Button>
          {f.hostKeyFingerprint ? <span className="font-mono text-[11px] text-muted">Onaylı: {f.hostKeyFingerprint}</span> : null}
        </div>

        {probe && !probe.ok ? <Alert kind="error">Sunucuya ulaşılamadı: {probe.error}</Alert> : null}

        {needsConfirm ? (
          <Alert kind={fpChanged ? 'error' : 'info'}>
            {fpChanged ? (
              <div className="mb-1 font-semibold">Dikkat: host key değişmiş! Sunucu yeniden kurulmadıysa bu bir saldırı olabilir.</div>
            ) : (
              <div className="mb-1 font-semibold">Bu sunucuya ilk kez bağlanılıyor. Host key parmak izini doğrulayın:</div>
            )}
            <div className="font-mono text-[12px]">
              {probe?.algorithm} {probe?.fingerprint}
            </div>
            <div className="mt-1 text-[11px] text-ink-2">
              Sunucuda kontrol: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
            </div>
            <div className="mt-2">
              <Button small variant="primary" onClick={() => void confirmKey()}>
                Parmak izini onayla ve devam et
              </Button>
            </div>
          </Alert>
        ) : null}

        {test ? <TestView t={test} /> : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>İzleme</SectionTitle>
        <Field label="Sunucu seviyesinde systemd servisleri" hint="Virgülle ayırın. Keşif sırasında otomatik önerilir.">
          <input value={unitsText} onChange={(e) => setUnitsText(e.target.value)} placeholder="nginx, docker, fail2ban, tailscaled" />
        </Field>
        <Toggle
          checked={!!f.asterisk}
          onChange={(v) => set('asterisk', v)}
          label="Asterisk CLI okumaları"
          hint="asterisk -rx ile aktif çağrı / trunk kaydı. root değilseniz sudoers kuralı gerekir (README)."
        />
        <Toggle checked={!!f.prometheus} onChange={(v) => set('prometheus', v)} label="Prometheus uzun geçmiş" hint="SSH tüneliyle sunucudaki 127.0.0.1:9090'a sorgu atılır." />
        <Toggle checked={f.enabled !== false} onChange={(v) => set('enabled', v)} label="İzleme etkin" />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>Bakım (yedek / geri yükleme)</SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="PostgreSQL container" hint="Boş: projelerdeki PostgreSQL ayarı ya da çalışan postgres container'ı otomatik bulunur">
            <input
              value={f.maintenance?.pgContainer ?? ''}
              onChange={(e) => set('maintenance', { ...f.maintenance, pgContainer: e.target.value })}
              placeholder="backend-postgres-1"
              autoComplete="off"
            />
          </Field>
          <Field label="PostgreSQL kullanıcısı" hint="Boş: container ortamındaki POSTGRES_USER okunur">
            <input
              value={f.maintenance?.pgUser ?? ''}
              onChange={(e) => set('maintenance', { ...f.maintenance, pgUser: e.target.value })}
              placeholder="asistan"
              autoComplete="off"
            />
          </Field>
        </div>
      </Card>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null || !f.hostKeyFingerprint || !f.name}>
          {busy === 'save' ? 'Kaydediliyor…' : server ? 'Kaydet' : 'Kaydet ve keşfet →'}
        </Button>
        <Button variant="ghost" onClick={() => nav(server ? { view: 'server', serverId: server.id } : { view: 'home' })}>
          Vazgeç
        </Button>
        {!f.hostKeyFingerprint ? <span className="text-[12px] text-muted">Kaydetmek için önce bağlantıyı test edip host key'i onaylayın.</span> : null}
        {server ? (
          <div className="ml-auto">
            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-[12px] text-ink-2">Sunucu, projeleri ve geçmişi silinsin mi?</span>
                <Button variant="danger" onClick={() => void remove()}>
                  Evet, sil
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Vazgeç
                </Button>
              </span>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Sunucuyu sil
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TestView({ t }: { t: TestResult }): ReactNode {
  if (!t.ok) return <Alert kind="error">Bağlantı başarısız: {t.error}</Alert>
  return (
    <div className="flex flex-col gap-2">
      <Alert kind="ok">
        <div className="font-semibold">Bağlantı başarılı ({t.latencyMs} ms)</div>
        <div className="font-mono text-[11px] break-all text-ink-2">{t.uname}</div>
        <div className="font-mono text-[11px] break-all text-ink-2">{t.id}</div>
        <div className="mt-1 text-[12px]">
          Docker: {t.dockerAccess ? `erişim var (v${t.dockerVersion})` : 'erişim yok'} · Asterisk CLI:{' '}
          {{ ok: 'erişim var', 'no-sudo': 'sudoers kuralı yok', 'not-installed': 'kurulu değil', unknown: 'bilinmiyor' }[t.asteriskAccess]}
        </div>
      </Alert>
      {t.warnings.map((w) => (
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
