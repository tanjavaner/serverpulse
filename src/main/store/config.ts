import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dedupeProjectIds } from '@shared/projects'
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type AppSettings, type Intervals, type ProjectConfig, type ServerConfig, type Thresholds } from '@shared/types'

interface ConfigFile {
  version: 1
  servers: ServerConfig[]
  projects: ProjectConfig[]
  settings: AppSettings
  /** Sessize alınanlar: sorun anahtarı ya da "sunucuId:" öneki → bitiş zamanı (ms). */
  mutes: Record<string, number>
}

/** Sessize alma en fazla bu kadar sürebilir (unutulan sessizlik alarmları sonsuza dek kapatmasın). */
export const MAX_MUTE_MS = 30 * 24 * 3600_000

/** Ayar yamasını birleştirir; sayısal alanlar SETTINGS_LIMITS'e göre doğrulanır (geçersiz değer → base'deki değer). */
export function mergeSettings(base: AppSettings, patch: Partial<AppSettings> | undefined): AppSettings {
  if (!patch) return structuredClone(base)
  const merged: AppSettings = {
    ...base,
    ...patch,
    intervals: { ...base.intervals, ...(patch.intervals ?? {}) },
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
    remoteNotify: {
      telegram: { ...base.remoteNotify.telegram, ...(patch.remoteNotify?.telegram ?? {}) },
      webhook: { ...base.remoteNotify.webhook, ...(patch.remoteNotify?.webhook ?? {}) }
    }
  }
  return sanitizeSettings(merged, base)
}

function clampNum(v: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

/** Sonlu olmayan sayılar fallback'teki değerde kalır, aralık dışındakiler sınıra çekilir. */
export function sanitizeSettings(s: AppSettings, fallback: AppSettings): AppSettings {
  const L = SETTINGS_LIMITS
  const intervals = { ...s.intervals }
  for (const k of Object.keys(L.intervals) as (keyof Intervals)[]) {
    intervals[k] = clampNum(s.intervals[k], fallback.intervals[k], L.intervals[k])
  }
  const thresholds = { ...s.thresholds }
  for (const k of Object.keys(L.thresholds) as (keyof Thresholds)[]) {
    thresholds[k] = clampNum(s.thresholds[k], fallback.thresholds[k], L.thresholds[k])
  }
  const language = s.language === 'tr' || s.language === 'en' || s.language === 'system' ? s.language : fallback.language
  return { ...s, language, intervals, thresholds, retentionHours: clampNum(s.retentionHours, fallback.retentionHours, L.retentionHours) }
}

/** Atomik yazma: önce .tmp, sonra rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

export class ConfigStore {
  private path: string
  private data: ConfigFile

  constructor(dir: string) {
    this.path = join(dir, 'config.json')
    this.data = { version: 1, servers: [], projects: [], settings: structuredClone(DEFAULT_SETTINGS), mutes: {} }
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ConfigFile>
        this.data = {
          version: 1,
          servers: Array.isArray(raw.servers) ? raw.servers : [],
          projects: Array.isArray(raw.projects) ? raw.projects : [],
          // Dil ayarı gelmeden önce kurulmuş uygulamalar Türkçe kalsın (yeni kurulumlar sistem dilini izler)
          settings: mergeSettings(DEFAULT_SETTINGS, raw.settings ? { language: 'tr', ...(raw.settings as Partial<AppSettings>) } : undefined),
          mutes: raw.mutes && typeof raw.mutes === 'object' && !Array.isArray(raw.mutes) ? raw.mutes : {}
        }
        // Eski keşfin ürettiği çakışan proje kimliklerini onar (aynı id'li ikinci proje açılamıyordu)
        const fixed = dedupeProjectIds(this.data.projects)
        if (fixed.changed) {
          this.data.projects = fixed.projects
          this.persist()
        }
      } catch (e) {
        // Bozuk dosyayı ezmemek için yedekle
        renameSync(this.path, `${this.path}.broken-${Date.now()}`)
        console.error('config.json okunamadı, yedeklendi:', (e as Error).message)
      }
    }
  }

  private persist(): void {
    writeJsonAtomic(this.path, this.data)
  }

  get servers(): ServerConfig[] {
    return this.data.servers
  }

  get projects(): ProjectConfig[] {
    return this.data.projects
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  server(id: string): ServerConfig | undefined {
    return this.data.servers.find((s) => s.id === id)
  }

  projectsOf(serverId: string): ProjectConfig[] {
    return this.data.projects.filter((p) => p.serverId === serverId)
  }

  upsertServer(s: ServerConfig): void {
    const i = this.data.servers.findIndex((x) => x.id === s.id)
    if (i >= 0) this.data.servers[i] = s
    else this.data.servers.push(s)
    this.persist()
  }

  removeServer(id: string): void {
    this.data.servers = this.data.servers.filter((s) => s.id !== id)
    this.data.projects = this.data.projects.filter((p) => p.serverId !== id)
    this.persist()
  }

  replaceProjects(serverId: string, projects: ProjectConfig[]): void {
    const all = [...this.data.projects.filter((p) => p.serverId !== serverId), ...projects.map((p) => ({ ...p, serverId }))]
    this.data.projects = dedupeProjectIds(all).projects
    this.persist()
  }

  removeProject(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    this.persist()
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = mergeSettings(this.data.settings, patch)
    this.persist()
    return this.data.settings
  }

  /** Süresi dolmamış sessizlikler (dolanlar burada temizlenir). */
  activeMutes(now = Date.now()): Record<string, number> {
    const active = Object.fromEntries(Object.entries(this.data.mutes).filter(([, until]) => typeof until === 'number' && until > now))
    if (Object.keys(active).length !== Object.keys(this.data.mutes).length) {
      this.data.mutes = active
      this.persist()
    }
    return active
  }

  setMute(key: string, until: number | null): void {
    if (until === null) delete this.data.mutes[key]
    else this.data.mutes[key] = until
    this.persist()
  }
}
