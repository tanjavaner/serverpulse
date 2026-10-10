import { describe, expect, it } from 'vitest'
import { composeSpec } from '../src/main/maintenance'
import { reclaimedSummary } from '../src/main/operations'
import { CMD, UnsafeInputError } from '../src/main/ssh/commands'
import { parseDockerPs } from '../src/main/parsers/docker'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { DEFAULT_SETTINGS, type ContainerInfo, type ProjectConfig, type ServerConfig, type ServerState } from '../src/shared/types'

const ctr = (name: string, extra: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: name, name, image: 'img', state: 'running', status: 'Up', health: null, restartCount: 0, lastRestartIncreaseAt: null,
  ports: '', cpuPct: null, memBytes: null, memPct: null, ...extra
})
const project = (containers: string[]): ProjectConfig => ({ id: 'p', serverId: 's', name: 'web', containers, containerRoles: {}, systemdUnits: [], httpChecks: [], asterisk: false })

describe('compose bilgisi', () => {
  it('etiketlerden proje adı, dizin ve dosyaları alır', () => {
    const files = ['/opt/web/docker-compose.yml', '/opt/web/docker-compose.prod.yml']
    const spec = composeSpec(project(['web-api-1', 'web-db-1']), [
      ctr('web-api-1', { composeProject: 'web', workingDir: '/opt/web', composeFiles: files }),
      ctr('web-db-1', { composeProject: 'web', workingDir: '/opt/web', composeFiles: files }),
      ctr('other-1', { composeProject: 'other', workingDir: '/opt/other' })
    ])
    expect(spec).toEqual({ project: 'web', dir: '/opt/web', files })
  })

  it('compose etiketi yoksa ya da birden çok compose projesi varsa reddeder', () => {
    expect(() => composeSpec(project(['plain']), [ctr('plain')])).toThrow()
    expect(() =>
      composeSpec(project(['a-1', 'b-1']), [ctr('a-1', { composeProject: 'a', workingDir: '/a' }), ctr('b-1', { composeProject: 'b', workingDir: '/b' })])
    ).toThrow(/a, b/)
  })

  it('docker ps etiketlerinden compose dosyalarını okur (virgüllü değer)', () => {
    const line = JSON.stringify({
      ID: '1', Names: 'web-api-1', Image: 'x', State: 'running', Status: 'Up',
      Labels: 'com.docker.compose.project=web,com.docker.compose.project.config_files=/opt/web/a.yml,/opt/web/b.yml,com.docker.compose.project.working_dir=/opt/web'
    })
    expect(parseDockerPs(line)[0]).toMatchObject({ composeProject: 'web', workingDir: '/opt/web', composeFiles: ['/opt/web/a.yml', '/opt/web/b.yml'] })
  })
})

describe('yönetim komutları', () => {
  it('container işlemi yalnızca start/stop/restart ve güvenli adla', () => {
    expect(CMD.containerAction('web-api-1', 'stop')).toBe('docker stop web-api-1 2>&1')
    expect(() => CMD.containerAction('web;rm', 'stop')).toThrow(UnsafeInputError)
    expect(() => CMD.containerAction('web', 'rm' as never)).toThrow(UnsafeInputError)
  })

  it('deploy komutu ayrık çalışır ve çıkış kodunu dosyaya yazar', () => {
    const c = CMD.deployStart('20261008-120000', { project: 'web', dir: '/opt/web', files: [] })
    expect(c).toContain('setsid -f nohup bash -o pipefail')
    expect(c).toContain('docker compose -p web pull && docker compose -p web up -d')
    expect(c).toContain('echo $? > "$HOME/serverpulse-maint/deploy-20261008-120000.rc"')
  })
})

describe('deploy sırasında alarmlar', () => {
  it('container kesintisi alarm üretmez (en fazla 10 dk)', () => {
    const server = { id: 's', name: 'VDS', host: 'h', port: 22, username: 'u', authType: 'key', systemdUnits: [], asterisk: false, prometheus: false, enabled: true } as ServerConfig
    const now = Date.now()
    const st: ServerState = {
      serverId: 's', connection: 'ready', errors: {}, http: {}, ssl: {}, postgres: {},
      docker: { ts: now, available: true, containers: [ctr('web-api-1', { state: 'exited', status: 'Exited (1)' })] },
      maintenance: { step: 'deploy', since: now - 60_000 }
    }
    expect(evaluateServer(server, [project(['web-api-1'])], st, DEFAULT_SETTINGS.thresholds, now)).toEqual([])
    st.maintenance!.since = now - 11 * 60_000
    expect(evaluateServer(server, [project(['web-api-1'])], st, DEFAULT_SETTINGS.thresholds, now)).toHaveLength(1)
  })
})

describe('docker temizliği', () => {
  it('volume ve container prune komutu yoktur', () => {
    for (const mode of ['safe', 'images'] as const) expect(CMD.prune(mode)).not.toMatch(/volume|container prune|system prune/)
    expect(CMD.prune('images')).toBe('docker image prune -af 2>&1')
    expect(() => CMD.prune('all' as never)).toThrow(UnsafeInputError)
  })

  it('geri kazanılan alanı toplar, 0B satırlarını atlar', () => {
    const out = 'Deleted Images:\nuntagged: x\nTotal reclaimed space: 1.2GB\nDeleted build cache objects:\nabc\nTotal reclaimed space: 0B'
    expect(reclaimedSummary(out)).toEqual(['1.2GB'])
  })
})
