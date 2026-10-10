import type { HttpCheck, ProjectConfig } from './types'

/**
 * Proje önerilerini birleştirme ve proje kimliklerini tekilleştirme yardımcıları (saf fonksiyonlar;
 * keşif ekranı ve main process ortak kullanır).
 */

/** Anlamlı proje adı olmayan dizinler: bunların altındaki projeler "kardeş" sayılmaz. */
const GENERIC_DIRS = new Set([
  'opt', 'srv', 'home', 'var', 'www', 'root', 'data', 'usr', 'local',
  'apps', 'app', 'projects', 'project', 'stacks', 'stack', 'services', 'docker', 'compose', 'deploy', 'repo', 'src', 'code'
])

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'
}

const segments = (dir: string): string[] => dir.replace(/\/+$/, '').split('/').filter(Boolean)

export function baseName(dir: string): string {
  return segments(dir).pop() ?? dir
}

/** Ortak üst dizin ("/opt/apps/x/backend" + "/opt/apps/x/socket" → "/opt/apps/x"); yalnızca "/" ortaksa undefined. */
export function commonDir(dirs: string[]): string | undefined {
  const parts = dirs.map(segments)
  if (!parts.length) return undefined
  const common: string[] = []
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) common.push(parts[0][i])
    else break
  }
  return common.length ? `/${common.join('/')}` : undefined
}

/** Benzersiz id: çakışırsa -2, -3… eklenir. */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

export interface MergeSuggestion {
  /** Ortak üst dizin. */
  dir: string
  /** Birleşik proje için önerilen ad (üst dizinin adı). */
  name: string
  ids: string[]
}

/**
 * Aynı anlamlı üst dizini paylaşan öneriler (ör. /opt/apps/voice_assistant/backend ve …/socket):
 * büyük ihtimalle tek bir ürünün parçaları. Yalnızca öneri; birleştirmeyi kullanıcı onaylar.
 */
export function mergeSuggestions(projects: Pick<ProjectConfig, 'id' | 'workingDir'>[]): MergeSuggestion[] {
  const groups = new Map<string, string[]>()
  for (const p of projects) {
    if (!p.workingDir) continue
    const parts = segments(p.workingDir)
    if (parts.length < 2) continue
    const parent = `/${parts.slice(0, -1).join('/')}`
    if (GENERIC_DIRS.has(baseName(parent).toLowerCase())) continue
    groups.set(parent, [...(groups.get(parent) ?? []), p.id])
  }
  return [...groups.entries()].filter(([, ids]) => ids.length >= 2).map(([dir, ids]) => ({ dir, name: baseName(dir), ids }))
}

/** Birden çok projeyi tek projede toplar: container, rol, servis ve kontroller birleşir; tekrarlar atılır. */
export function mergeProjects(list: ProjectConfig[], name: string, id: string): ProjectConfig {
  const checks: HttpCheck[] = []
  const seen = new Set<string>()
  for (const c of list.flatMap((p) => p.httpChecks)) {
    const key = c.mode === 'public' ? `u:${c.url}` : `l:${c.host}:${c.port}${c.path ?? ''}`
    if (seen.has(c.id) || seen.has(key)) continue
    seen.add(c.id)
    seen.add(key)
    checks.push(c)
  }
  const dirs = list.map((p) => p.workingDir).filter((d): d is string => !!d)
  return {
    id,
    serverId: list[0]?.serverId ?? '',
    name,
    workingDir: dirs.length > 1 ? (commonDir(dirs) ?? dirs[0]) : dirs[0],
    containers: [...new Set(list.flatMap((p) => p.containers))].sort(),
    containerRoles: Object.assign({}, ...list.map((p) => p.containerRoles)),
    systemdUnits: [...new Set(list.flatMap((p) => p.systemdUnits))],
    httpChecks: checks,
    postgres: list.find((p) => p.postgres)?.postgres,
    asterisk: list.some((p) => p.asterisk)
  }
}

/**
 * Aynı id'yi taşıyan projelerden ilki dışındakilere yeni id verir. Eski sürümlerin keşfi farklı yollardaki
 * aynı adlı klasörlere (ör. iki ayrı "backend") aynı id'yi veriyordu; kenar çubuğu yanlış projeyi açıyordu.
 */
export function dedupeProjectIds<T extends Pick<ProjectConfig, 'id'>>(list: T[], newId: (base: string, taken: Set<string>) => string = uniqueId): { projects: T[]; changed: boolean } {
  // Tüm mevcut kimlikler baştan ayrılır: yeni kimlik, zaten benzersiz olan bir projenin kimliğini kapmasın
  const taken = new Set(list.map((p) => p.id))
  const firstSeen = new Set<string>()
  let changed = false
  const projects = list.map((p) => {
    if (!firstSeen.has(p.id)) {
      firstSeen.add(p.id)
      return p
    }
    changed = true
    const id = newId(p.id, taken)
    taken.add(id)
    return { ...p, id }
  })
  return { projects, changed }
}
