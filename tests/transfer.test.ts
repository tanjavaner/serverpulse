import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ProjectConfig, type ServerConfig } from '../src/shared/types'
import { applyImport, decryptBundle, encryptBundle, parseExport, planImport, WrongPasswordError, type ExportFile } from '../src/main/transfer'
import type { Monitor } from '../src/main/monitor'

const srv = (id: string, extra: Partial<ServerConfig> = {}): ServerConfig => ({
  id,
  name: `S-${id}`,
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  authType: 'key',
  hostKeyFingerprint: 'SHA256:abc',
  systemdUnits: [],
  asterisk: false,
  prometheus: false,
  enabled: true,
  ...extra
})
const proj = (id: string, serverId: string): ProjectConfig => ({ id, serverId, name: id, containers: [], containerRoles: {}, systemdUnits: [], httpChecks: [], asterisk: false })
const file = (extra: Partial<ExportFile> = {}): ExportFile => ({
  app: 'serverpulse',
  format: 1,
  exportedAt: '2026-10-08T10:00:00.000Z',
  appVersion: '0.3.0',
  servers: [srv('a'), srv('b')],
  projects: [proj('p1', 'a'), proj('p2', 'b')],
  settings: DEFAULT_SETTINGS,
  ...extra
})

describe('şifreli sırlar', () => {
  const bundle = { servers: { a: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----' } }, notify: { telegramToken: '123:abc' } }

  it('doğru parolayla açılır, düz metin dosyada görünmez', () => {
    const blob = encryptBundle(bundle, 'çok-gizli-parola')
    expect(JSON.stringify(blob)).not.toContain('PRIVATE KEY')
    expect(decryptBundle(blob, 'çok-gizli-parola')).toEqual(bundle)
  })

  it('yanlış parola ya da değiştirilmiş veri reddedilir', () => {
    const blob = encryptBundle(bundle, 'çok-gizli-parola')
    expect(() => decryptBundle(blob, 'yanlis-parola')).toThrow(WrongPasswordError)
    const tampered = { ...blob, data: Buffer.from('x' + Buffer.from(blob.data, 'base64').toString('latin1'), 'latin1').toString('base64') }
    expect(() => decryptBundle(tampered, 'çok-gizli-parola')).toThrow(WrongPasswordError)
  })

  it('kısa parolayı kabul etmez', () => {
    expect(() => encryptBundle(bundle, 'kisa')).toThrow()
  })
})

describe('dosya doğrulama ve plan', () => {
  it('başka JSON dosyalarını reddeder', () => {
    expect(() => parseExport('{"servers": []}')).toThrow()
    expect(() => parseExport('not json')).toThrow()
    expect(parseExport(JSON.stringify(file())).servers).toHaveLength(2)
  })

  it('var olan sunucuları ve projelerini atlar', () => {
    const plan = planImport(file(), { serverIds: new Set(['a']), projectIds: new Set() })
    expect(plan.servers.map((s) => s.id)).toEqual(['b'])
    expect(plan.projects.map((p) => p.id)).toEqual(['p2'])
    expect(plan.skipped).toBe(1)
  })
})

describe('içe aktarma', () => {
  function fakeMonitor(existing: ServerConfig[] = []) {
    const added: { id: string; projects: string[]; creds: unknown }[] = []
    const texts = new Map<string, string>()
    const m = {
      config: { servers: existing, projects: [] as ProjectConfig[], settings: DEFAULT_SETTINGS },
      secrets: { get: () => null, getText: (k: string) => texts.get(k) ?? null, setText: (k: string, v: string) => texts.set(k, v) },
      addImportedServer: (s: ServerConfig, ps: ProjectConfig[], creds: unknown) => added.push({ id: s.id, projects: ps.map((p) => p.id), creds }),
      saveSettings: () => DEFAULT_SETTINGS
    }
    return { monitor: m as unknown as Monitor, added, texts }
  }

  it('şifreli dosya parolasız içe aktarılmaz', () => {
    const { monitor, added } = fakeMonitor()
    const f = file({ secrets: encryptBundle({ servers: {}, notify: {} }, 'parola-123') })
    expect(applyImport(monitor, f, { settings: false })).toMatchObject({ ok: false, needsPassword: true })
    expect(added).toEqual([])
  })

  it('sunucuları sırlarıyla ekler; agent sunucusuna boş kimlik bilgisi verir', () => {
    const { monitor, added, texts } = fakeMonitor([srv('a')])
    const f = file({
      servers: [srv('a'), srv('b'), srv('c', { authType: 'agent' })],
      secrets: encryptBundle({ servers: { b: { password: 'pw' } }, notify: { webhookUrl: 'https://hooks.example.com/x' } }, 'parola-123')
    })
    const r = applyImport(monitor, f, { password: 'parola-123', settings: false })
    expect(r).toMatchObject({ ok: true, added: 2, skipped: 1 })
    expect(added).toEqual([
      { id: 'b', projects: ['p2'], creds: { password: 'pw' } },
      { id: 'c', projects: [], creds: {} }
    ])
    expect(texts.get('notify.webhook.url')).toBe('https://hooks.example.com/x')
  })
})

describe('Monitor.addImportedServer', () => {
  it('alanları doğrular, projeleri temizler ve kalıcı yazar', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Monitor } = await import('../src/main/monitor')
    const { ConfigStore } = await import('../src/main/store/config')
    const dir = mkdtempSync(join(tmpdir(), 'sp-imp-'))
    const m = new Monitor(dir)
    try {
      // Bağlantı denenmesin diye devre dışı sunucu; sır yok
      m.addImportedServer(srv('x', { enabled: false, hostKeyFingerprint: 'not-a-fingerprint' }), [{ ...proj('p9', 'other'), containers: ['ok-name', 'bad;name'] }], null)
      expect(() => m.addImportedServer(srv('y', { host: 'bad host!' }), [], null)).toThrow()
      const saved = new ConfigStore(dir)
      expect(saved.servers.map((s) => s.id)).toEqual(['x'])
      expect(saved.servers[0].hostKeyFingerprint).toBeUndefined()
      expect(saved.projects).toEqual([expect.objectContaining({ id: 'p9', serverId: 'x', containers: ['ok-name'] })])
    } finally {
      m.stop()
    }
  })

  it('sır kaydı olmayan agent sunucusu boş kimlik bilgisiyle bağlanır, anahtarlı sunucu bağlanmaz', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Monitor } = await import('../src/main/monitor')
    const m = new Monitor(mkdtempSync(join(tmpdir(), 'sp-creds-')))
    try {
      m.config.upsertServer(srv('ag', { authType: 'agent', agent: 'openssh', enabled: false }))
      m.config.upsertServer(srv('k', { enabled: false }))
      expect(m.credsFor('ag')).toEqual({})
      expect(m.credsFor('k')).toBeNull()
      expect(m.credsFor('yok')).toBeNull()
    } finally {
      m.stop()
    }
  })
})
