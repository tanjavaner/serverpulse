import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { AppSettings, ImportResult, ProjectConfig, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import type { Credentials } from './ssh/connection'
import type { Monitor } from './monitor'
import { K_TOKEN, K_URL } from './notify'

/**
 * Yapılandırmayı başka bir bilgisayara taşımak için dışa/içe aktarma dosyası.
 * Sırlar (şifre, özel anahtar, bildirim token'ı) yalnızca kullanıcı isterse ve parolayla şifrelenerek eklenir:
 * scrypt (N=2^15) ile türetilen anahtar + AES-256-GCM. safeStorage makineye bağlı olduğu için kullanılamaz.
 */

export interface SecretBundle {
  servers: Record<string, Credentials>
  notify: { telegramToken?: string; webhookUrl?: string }
}

export interface EncryptedBlob {
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  data: string
}

export interface ExportFile {
  app: 'serverpulse'
  format: 1
  exportedAt: string
  appVersion: string
  servers: ServerConfig[]
  projects: ProjectConfig[]
  settings: AppSettings
  secrets?: EncryptedBlob
}

export class WrongPasswordError extends Error {}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSWORD = 8

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, SCRYPT)
}

export function encryptBundle(bundle: SecretBundle, password: string): EncryptedBlob {
  if (password.length < MIN_PASSWORD) throw new Error(t('xfer.shortPassword', { n: MIN_PASSWORD }))
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()])
  return { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function decryptBundle(blob: EncryptedBlob, password: string): SecretBundle {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(blob.salt, 'base64')), Buffer.from(blob.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(plain) as SecretBundle
  } catch {
    // GCM etiketi tutmazsa parola yanlış ya da dosya değiştirilmiş
    throw new WrongPasswordError(t('xfer.wrongPassword'))
  }
}

/** Dosyayı yapısal olarak doğrular; geçersizse anlaşılır bir hata fırlatır. */
export function parseExport(text: string): ExportFile {
  let raw: Partial<ExportFile>
  try {
    raw = JSON.parse(text) as Partial<ExportFile>
  } catch {
    throw new Error(t('xfer.notExport'))
  }
  if (raw?.app !== 'serverpulse' || raw.format !== 1 || !Array.isArray(raw.servers) || !Array.isArray(raw.projects)) {
    throw new Error(t('xfer.notExport'))
  }
  if (raw.secrets && !(raw.secrets.kdf === 'scrypt' && raw.secrets.salt && raw.secrets.iv && raw.secrets.tag && raw.secrets.data)) {
    throw new Error(t('xfer.notExport'))
  }
  return raw as ExportFile
}

/** İçe aktarılacakları seçer: zaten var olan sunucu/proje id'leri atlanır, projeler yalnızca yeni sunucular için alınır. */
export function planImport(
  file: ExportFile,
  existing: { serverIds: Set<string>; projectIds: Set<string> }
): { servers: ServerConfig[]; projects: ProjectConfig[]; skipped: number } {
  const servers = file.servers.filter((s) => s && typeof s.id === 'string' && !existing.serverIds.has(s.id))
  const ids = new Set(servers.map((s) => s.id))
  const projects = file.projects.filter((p) => p && ids.has(p.serverId) && !existing.projectIds.has(p.id))
  return { servers, projects, skipped: file.servers.length - servers.length }
}

// ---------------------------------------------------------------------------
// Monitor ile birleştirme
// ---------------------------------------------------------------------------

export function buildExport(monitor: Monitor, appVersion: string, opts: { includeSecrets: boolean; password?: string }, now = new Date()): ExportFile {
  const servers = monitor.config.servers
  const file: ExportFile = {
    app: 'serverpulse',
    format: 1,
    exportedAt: now.toISOString(),
    appVersion,
    servers,
    projects: monitor.config.projects,
    settings: monitor.config.settings
  }
  if (opts.includeSecrets) {
    const bundle: SecretBundle = { servers: {}, notify: {} }
    for (const s of servers) {
      const c = monitor.secrets.get(s.id)
      if (c) bundle.servers[s.id] = c
    }
    bundle.notify.telegramToken = monitor.secrets.getText(K_TOKEN) ?? undefined
    bundle.notify.webhookUrl = monitor.secrets.getText(K_URL) ?? undefined
    file.secrets = encryptBundle(bundle, opts.password ?? '')
  }
  return file
}

/** Sunucuları (ve projelerini) ekler; mevcut olanlara dokunmaz. Bildirim sırları yalnızca hedefte yoksa yazılır. */
export function applyImport(monitor: Monitor, file: ExportFile, opts: { password?: string; settings: boolean }): ImportResult {
  if (file.secrets && !opts.password) return { ok: false, needsPassword: true, added: 0, skipped: 0, errors: [] }
  const bundle = file.secrets ? decryptBundle(file.secrets, opts.password ?? '') : null
  const plan = planImport(file, {
    serverIds: new Set(monitor.config.servers.map((s) => s.id)),
    projectIds: new Set(monitor.config.projects.map((p) => p.id))
  })
  const errors: string[] = []
  let added = 0
  for (const s of plan.servers) {
    try {
      // Agent ile girişte sır yoktur; boş kimlik bilgisi bağlantının denenmesine izin verir
      const creds = bundle?.servers[s.id] ?? (s.authType === 'agent' ? {} : null)
      monitor.addImportedServer(s, plan.projects.filter((p) => p.serverId === s.id), creds)
      added++
    } catch (e) {
      errors.push(`${s.name ?? s.id}: ${(e as Error).message}`)
    }
  }
  if (bundle?.notify.telegramToken && !monitor.secrets.getText(K_TOKEN)) monitor.secrets.setText(K_TOKEN, bundle.notify.telegramToken)
  if (bundle?.notify.webhookUrl && !monitor.secrets.getText(K_URL)) monitor.secrets.setText(K_URL, bundle.notify.webhookUrl)
  if (opts.settings && file.settings) {
    const hasToken = !!monitor.secrets.getText(K_TOKEN)
    const hasUrl = !!monitor.secrets.getText(K_URL)
    const rn = file.settings.remoteNotify
    monitor.saveSettings({
      ...file.settings,
      remoteNotify: {
        telegram: {
          ...monitor.config.settings.remoteNotify.telegram,
          ...rn?.telegram,
          enabled: !!rn?.telegram?.enabled && hasToken,
          chatId: rn?.telegram?.chatId ?? '',
          hasToken
        },
        webhook: { enabled: !!rn?.webhook?.enabled && hasUrl, hasUrl }
      }
    })
  }
  return { ok: errors.length === 0, added, skipped: plan.skipped, errors }
}
