import { describe, expect, it } from 'vitest'
import { fx } from './helpers'
import { parseDockerPs } from '../src/main/parsers/docker'
import { parseNginxSites, parseRunningUnits } from '../src/main/parsers/misc'
import { buildProposals, guessRole, projectNameFrom, suggestUnits } from '../src/main/discovery/proposals'

// Kabul referansı: plandaki VDS envanteri.
describe('keşif → proje önerileri (VDS referansı)', () => {
  const containers = parseDockerPs(fx('docker_ps.jsonl'))
  const runningUnits = parseRunningUnits(fx('systemctl_running.txt'))
  const nginx = parseNginxSites(fx('nginx_sites.txt'))
  const projects = buildProposals({ serverId: 'vds', containers, runningUnits, nginx, pgUsers: { 'backend-postgres-1': 'restaurant_app' } })
  const byName = Object.fromEntries(projects.map((p) => [p.name, p]))

  it('4 proje bulur', () => {
    expect(Object.keys(byName).sort()).toEqual(['backend', 'monitoring', 'sesli_asistan', 'yukselyazilim.com-web'])
  })

  it('sesli_asistan: api + telephony + systemd asterisk', () => {
    const p = byName.sesli_asistan
    expect(p.workingDir).toBe('/opt/apps/sesli_asistan/repo')
    expect(p.containers).toEqual(['sesli-asistan-api', 'sesli-asistan-telephony'])
    expect(p.asterisk).toBe(true)
    expect(p.systemdUnits).toContain('asterisk')
    expect(p.httpChecks).toContainEqual(expect.objectContaining({ mode: 'local', host: '127.0.0.1', port: 8082 }))
    expect(p.containerRoles['sesli-asistan-api']).toBe('backend')
    expect(p.containerRoles['sesli-asistan-telephony']).toBe('asterisk')
  })

  it('backend: .NET api + postgres 17 + api-restaurant domain', () => {
    const p = byName.backend
    expect(p.containers).toEqual(['backend-api-1', 'backend-postgres-1'])
    expect(p.postgres).toEqual({ container: 'backend-postgres-1', user: 'restaurant_app' })
    expect(p.containerRoles['backend-postgres-1']).toBe('db')
    const pub = p.httpChecks.filter((c) => c.mode === 'public').map((c) => c.url)
    expect(pub).toEqual(['https://api-restaurant.yukselyazilim.com/'])
    // Postgres portu (100.99.9.0:5432) için HTTP kontrolü önerilmez
    expect(p.httpChecks.some((c) => c.port === 5432)).toBe(false)
  })

  it('frontend: restaurant + tanitim domainleri', () => {
    const p = byName['yukselyazilim.com-web']
    expect(p.containers).toEqual(['yuksel-yazilim-frontend'])
    expect(p.containerRoles['yuksel-yazilim-frontend']).toBe('frontend')
    const pub = p.httpChecks.filter((c) => c.mode === 'public').map((c) => c.url)
    expect(pub).toEqual(['https://restaurant.yukselyazilim.com/', 'https://tanitim.yukselyazilim.com/'])
  })

  it('monitoring: prometheus, grafana (tailscale IP), exporter + node_exporter', () => {
    const p = byName.monitoring
    expect(p.containers).toEqual(['grafana', 'postgres-exporter', 'prometheus'])
    expect(p.systemdUnits).toContain('node_exporter')
    expect(p.postgres).toBeUndefined() // postgres-exporter bir DB değil
    expect(p.httpChecks).toContainEqual(expect.objectContaining({ host: '127.0.0.1', port: 9090, path: '/-/healthy' }))
    expect(p.httpChecks).toContainEqual(expect.objectContaining({ host: '100.99.9.0', port: 3000, path: '/api/health' }))
  })

  it('toplam 3 public domain', () => {
    const all = projects.flatMap((p) => p.httpChecks.filter((c) => c.mode === 'public'))
    expect(all).toHaveLength(3)
  })

  it('önerilen sunucu servisleri', () => {
    expect(suggestUnits(runningUnits)).toEqual(['nginx', 'docker', 'asterisk', 'fail2ban', 'tailscaled', 'node_exporter'])
  })

  it('aynı girdiyle deterministik', () => {
    const again = buildProposals({ serverId: 'vds', containers, runningUnits, nginx, pgUsers: { 'backend-postgres-1': 'restaurant_app' } })
    expect(again).toEqual(projects)
  })
})

describe('yardımcılar', () => {
  it('proje adı: genel dizin adlarında üst dizine çıkar', () => {
    expect(projectNameFrom('/opt/apps/sesli_asistan/repo', 'repo')).toBe('sesli_asistan')
    expect(projectNameFrom('/opt/monitoring/', 'monitoring')).toBe('monitoring')
    expect(projectNameFrom(undefined, 'x')).toBe('x')
  })

  it('rol tahmini', () => {
    expect(guessRole({ name: 'postgres-exporter', image: 'prometheuscommunity/postgres-exporter' })).toBe('monitoring')
    expect(guessRole({ name: 'db', image: 'postgres:17' })).toBe('db')
    expect(guessRole({ name: 'x', image: 'library/redis:7' })).toBe('db')
  })
})
