import type { ComponentRole, ContainerInfo, HttpCheck, ProjectConfig } from '@shared/types'
import { parsePublishedPorts } from '../parsers/docker'
import type { NginxServerBlock } from '../parsers/misc'

/** Keşifte varsayılan olarak önerilecek bilinen systemd servisleri. */
export const KNOWN_UNITS = [
  'nginx',
  'docker',
  'asterisk',
  'fail2ban',
  'tailscaled',
  'node_exporter',
  'prometheus-node-exporter',
  'postgresql',
  'redis-server',
  'caddy',
  'apache2',
  'mysql',
  'mariadb',
  'containerd',
  'ssh'
]

// ssh/containerd izlenebilir ama varsayılan listeyi kalabalıklaştırmasın
const DEFAULT_UNITS = KNOWN_UNITS.filter((u) => u !== 'ssh' && u !== 'containerd')

const GENERIC_DIR_NAMES = new Set(['repo', 'app', 'apps', 'src', 'docker', 'deploy', 'compose', 'code', 'project'])

export interface DiscoveryInput {
  serverId: string
  containers: ContainerInfo[]
  runningUnits: string[]
  nginx: NginxServerBlock[]
  pgUsers: Record<string, string>
}

export function projectNameFrom(workingDir: string | undefined, composeProject: string | undefined): string {
  if (workingDir) {
    const parts = workingDir.replace(/\/+$/, '').split('/').filter(Boolean)
    const base = parts[parts.length - 1]
    if (base && !GENERIC_DIR_NAMES.has(base.toLowerCase())) return base
    if (parts.length >= 2) return parts[parts.length - 2]
  }
  return composeProject ?? 'diger'
}

export function isPostgresImage(image: string): boolean {
  const name = image.split('@')[0].split(':')[0]
  const last = name.split('/').pop() ?? ''
  return last === 'postgres' || last === 'postgis' || /^timescaledb/.test(last)
}

export function guessRole(c: Pick<ContainerInfo, 'name' | 'image'>): ComponentRole {
  const s = `${c.name} ${c.image}`.toLowerCase()
  if (/exporter|prometheus|grafana|loki|promtail|alertmanager|cadvisor/.test(s)) return 'monitoring'
  if (isPostgresImage(c.image) || /mysql|mariadb|redis|mongo/.test(s)) return 'db'
  if (/telephony|asterisk|voip|\bsip\b/.test(s)) return 'asterisk'
  if (/frontend|\bweb\b|-web|nginx|next|nuxt|vite|react/.test(s)) return 'frontend'
  if (/\bapi\b|-api|backend|server|dotnet|aspnet/.test(s)) return 'backend'
  return 'other'
}

const KNOWN_HEALTH_PATHS: { re: RegExp; path: string }[] = [
  { re: /prometheus/, path: '/-/healthy' },
  { re: /grafana/, path: '/api/health' }
]

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'
}

/** Keşif çıktılarından proje önerileri üretir. Saf fonksiyon: aynı girdi → aynı çıktı. */
export function buildProposals(input: DiscoveryInput): ProjectConfig[] {
  const { serverId, containers, runningUnits, nginx } = input
  const groups = new Map<string, { name: string; workingDir?: string; containers: ContainerInfo[] }>()

  for (const c of containers) {
    const key = c.composeProject ?? `__standalone`
    const g = groups.get(key)
    if (g) g.containers.push(c)
    else
      groups.set(key, {
        name: c.composeProject ? projectNameFrom(c.workingDir, c.composeProject) : 'Diğer container\'lar',
        workingDir: c.workingDir,
        containers: [c]
      })
  }

  const projects: ProjectConfig[] = []
  const usedDomains = new Set<string>()

  for (const g of groups.values()) {
    const roles: Record<string, ComponentRole> = {}
    const checks: HttpCheck[] = []
    let postgres: ProjectConfig['postgres']

    for (const c of g.containers) {
      const role = guessRole(c)
      roles[c.name] = role
      if (!postgres && isPostgresImage(c.image)) {
        postgres = { container: c.name, user: input.pgUsers[c.name] || 'postgres' }
      }
      for (const pub of parsePublishedPorts(c.ports)) {
        if (role === 'db') continue
        const host = pub.ip === '0.0.0.0' ? '127.0.0.1' : pub.ip
        const known = KNOWN_HEALTH_PATHS.find((k) => k.re.test(`${c.name} ${c.image}`.toLowerCase()))
        checks.push({
          id: `${slug(c.name)}-local-${pub.port}`,
          name: `${c.name} (:${pub.port})`,
          role,
          mode: 'local',
          host,
          port: pub.port,
          path: known?.path ?? '/'
        })
        // Bu porta proxy yapan nginx domain'leri → public kontrol
        for (const block of nginx) {
          if (block.primaryPort !== pub.port) continue
          for (const domain of block.serverNames) {
            if (usedDomains.has(domain) || domain.includes('*')) continue
            usedDomains.add(domain)
            checks.push({
              id: `${slug(domain)}-public`,
              name: domain,
              role,
              mode: 'public',
              url: `${block.ssl ? 'https' : 'http'}://${domain}/`
            })
          }
        }
      }
    }

    projects.push({
      id: `${serverId}-${slug(g.name)}`,
      serverId,
      name: g.name,
      workingDir: g.workingDir,
      containers: g.containers.map((c) => c.name).sort(),
      containerRoles: roles,
      systemdUnits: [],
      httpChecks: checks,
      postgres,
      asterisk: false
    })
  }

  // systemd servislerini ilgili projelere iliştir
  const running = new Set(runningUnits)
  if (running.has('asterisk')) {
    const target =
      projects.find((p) => Object.values(p.containerRoles).includes('asterisk')) ??
      pushProject(projects, serverId, 'asterisk')
    target.asterisk = true
    target.systemdUnits.push('asterisk')
  }
  for (const exporter of ['node_exporter', 'prometheus-node-exporter']) {
    if (!running.has(exporter)) continue
    const target = projects.find((p) => Object.values(p.containerRoles).includes('monitoring'))
    if (target) target.systemdUnits.push(exporter)
  }

  // Hiçbir container'a bağlanamayan nginx domain'leri için bilgi amaçlı ayrı proje açılmaz; kullanıcı elle ekleyebilir.
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

function pushProject(projects: ProjectConfig[], serverId: string, name: string): ProjectConfig {
  const p: ProjectConfig = {
    id: `${serverId}-${slug(name)}`,
    serverId,
    name,
    containers: [],
    containerRoles: {},
    systemdUnits: [],
    httpChecks: [],
    asterisk: false
  }
  projects.push(p)
  return p
}

export function suggestUnits(runningUnits: string[]): string[] {
  const set = new Set(runningUnits)
  return DEFAULT_UNITS.filter((u) => set.has(u))
}
