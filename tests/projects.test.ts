import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commonDir, dedupeProjectIds, mergeProjects, mergeSuggestions } from '../src/shared/projects'
import { buildProposals } from '../src/main/discovery/proposals'
import { ConfigStore } from '../src/main/store/config'
import type { ContainerInfo, ProjectConfig } from '../src/shared/types'

const proj = (id: string, workingDir: string | undefined, extra: Partial<ProjectConfig> = {}): ProjectConfig => ({
  id, serverId: 's1', name: id, workingDir, containers: [], containerRoles: {}, systemdUnits: [], httpChecks: [], asterisk: false, ...extra
})
const ctr = (name: string, composeProject: string, workingDir: string): ContainerInfo => ({
  id: name, name, image: 'img', state: 'running', status: 'Up', health: null, restartCount: 0, lastRestartIncreaseAt: null,
  composeProject, workingDir, ports: '', cpuPct: null, memBytes: null, memPct: null
})

describe('birleştirme önerileri', () => {
  it('aynı anlamlı üst dizindeki projeleri önerir (sesli_asistan/backend + socket)', () => {
    const s = mergeSuggestions([
      proj('a', '/opt/apps/sesli_asistan/backend'),
      proj('b', '/opt/apps/sesli_asistan/socket'),
      proj('c', '/opt/apps/blog'),
      proj('d', '/opt/apps/shop')
    ])
    expect(s).toEqual([{ dir: '/opt/apps/sesli_asistan', name: 'sesli_asistan', ids: ['a', 'b'] }])
  })

  it('genel dizinlerin (apps, srv, opt…) altındaki farklı projeleri birleştirmeyi önermez', () => {
    expect(mergeSuggestions([proj('a', '/srv/blog'), proj('b', '/srv/shop'), proj('c', '/home/web'), proj('d', '/home/api')])).toEqual([])
  })

  it('birleşik proje: container, rol, kontrol ve servisleri tekrar etmeden toplar', () => {
    const a = proj('a', '/opt/apps/x/backend', {
      containers: ['x-api-1', 'x-db-1'],
      containerRoles: { 'x-api-1': 'backend', 'x-db-1': 'db' },
      httpChecks: [{ id: 'h1', name: 'api', role: 'backend', mode: 'local', host: '127.0.0.1', port: 8080, path: '/' }],
      postgres: { container: 'x-db-1', user: 'app' }
    })
    const b = proj('b', '/opt/apps/x/socket', {
      containers: ['x-socket-1'],
      containerRoles: { 'x-socket-1': 'backend' },
      httpChecks: [{ id: 'h2', name: 'api again', role: 'backend', mode: 'local', host: '127.0.0.1', port: 8080, path: '/' }],
      systemdUnits: ['asterisk'],
      asterisk: true
    })
    const m = mergeProjects([a, b], 'x', 's1-x')
    expect(m).toMatchObject({ id: 's1-x', name: 'x', workingDir: '/opt/apps/x', containers: ['x-api-1', 'x-db-1', 'x-socket-1'], systemdUnits: ['asterisk'], asterisk: true })
    expect(m.httpChecks.map((c) => c.id)).toEqual(['h1'])
    expect(m.postgres).toEqual({ container: 'x-db-1', user: 'app' })
    expect(commonDir(['/opt/a', '/srv/b'])).toBeUndefined()
  })
})

describe('proje kimlikleri', () => {
  it('farklı yollardaki aynı adlı klasörler ayrı kimlik ve ayırt edici ad alır', () => {
    const ps = buildProposals({
      serverId: 's1',
      containers: [ctr('a-api-1', 'shop_backend', '/opt/apps/shop/backend'), ctr('b-api-1', 'blog_backend', '/opt/apps/blog/backend')],
      runningUnits: [],
      nginx: [],
      pgUsers: {}
    })
    expect(new Set(ps.map((p) => p.id)).size).toBe(2)
    expect(ps.map((p) => p.name).sort()).toEqual(['blog/backend', 'shop/backend'])
  })

  it('çakışan kimlikleri onarır; ilk proje kimliğini korur', () => {
    const { projects, changed } = dedupeProjectIds([proj('x', undefined), proj('x', undefined), proj('x-2', undefined)])
    expect(changed).toBe(true)
    expect(projects.map((p) => p.id)).toEqual(['x', 'x-3', 'x-2'])
  })

  it('eski config.json\'daki çakışan kimlikler açılışta onarılıp kaydedilir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-dup-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, servers: [], projects: [proj('s1-backend', '/a/backend'), proj('s1-backend', '/b/backend')], settings: {} }))
    const c = new ConfigStore(dir)
    expect(c.projects.map((p) => p.id)).toEqual(['s1-backend', 's1-backend-2'])
    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { projects: ProjectConfig[] }
    expect(saved.projects.map((p) => p.id)).toEqual(['s1-backend', 's1-backend-2'])
    // Kayıt sırasında da çakışma oluşamaz
    c.replaceProjects('s1', [proj('dup', undefined), proj('dup', undefined)])
    expect(c.projects.map((p) => p.id)).toEqual(['dup', 'dup-2'])
  })
})
