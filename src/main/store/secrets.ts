import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { Credentials } from '../ssh/connection'
import { writeJsonAtomic } from './config'

/**
 * SSH şifre/anahtarlarını Electron safeStorage ile şifreler (Windows: DPAPI, macOS: Keychain).
 * Düz metin hiçbir zaman diske yazılmaz. Şifreleme yoksa kaydetme reddedilir.
 */
export class SecretStore {
  private path: string
  private data: Record<string, string> = {}

  constructor(dir: string) {
    this.path = join(dir, 'secrets.json')
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
      } catch {
        this.data = {}
      }
    }
  }

  private ensureAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('İşletim sisteminin güvenli depolaması kullanılamıyor; kimlik bilgisi kaydedilmedi.')
    }
  }

  get(serverId: string): Credentials | null {
    const enc = this.data[serverId]
    if (!enc) return null
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))) as Credentials
    } catch {
      return null
    }
  }

  set(serverId: string, creds: Credentials): void {
    this.ensureAvailable()
    this.data[serverId] = safeStorage.encryptString(JSON.stringify(creds)).toString('base64')
    writeJsonAtomic(this.path, this.data)
  }

  remove(serverId: string): void {
    delete this.data[serverId]
    writeJsonAtomic(this.path, this.data)
  }
}
