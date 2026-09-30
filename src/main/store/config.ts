import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type ProjectConfig, type ServerConfig } from '@shared/types'

interface ConfigFile {
  version: 1
  servers: ServerConfig[]
  projects: ProjectConfig[]
  settings: AppSettings
}

export function mergeSettings(base: AppSettings, patch: Partial<AppSettings> | undefined): AppSettings {
  if (!patch) return structuredClone(base)
  return {
    ...base,
    ...patch,
    intervals: { ...base.intervals, ...(patch.intervals ?? {}) },
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) }
  }
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
    this.data = { version: 1, servers: [], projects: [], settings: structuredClone(DEFAULT_SETTINGS) }
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ConfigFile>
        this.data = {
          version: 1,
          servers: Array.isArray(raw.servers) ? raw.servers : [],
          projects: Array.isArray(raw.projects) ? raw.projects : [],
          settings: mergeSettings(DEFAULT_SETTINGS, raw.settings)
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
    this.data.projects = [...this.data.projects.filter((p) => p.serverId !== serverId), ...projects.map((p) => ({ ...p, serverId }))]
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
}
