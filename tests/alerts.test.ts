import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ContainerInfo, type ProjectConfig, type ServerConfig, type ServerState } from '../src/shared/types'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { AlertEngine } from '../src/main/alerts/engine'

const th = DEFAULT_SETTINGS.thresholds
const server: ServerConfig = {
  id: 's1',
  name: 'VDS',
  host: '100.99.9.0',
  port: 22,
  username: 'deploy',
  authType: 'key',
  hostKeyFingerprint: 'SHA256:x',
  systemdUnits: ['nginx'],
  asterisk: true,
  prometheus: false,
  enabled: true
}
const project: ProjectConfig = {
  id: 'p1',
  serverId: 's1',
  name: 'yukselyazilim.com-web',
  containers: ['yuksel-yazilim-frontend'],
  containerRoles: { 'yuksel-yazilim-frontend': 'frontend' },
  systemdUnits: [],
  httpChecks: [{ id: 'h1', name: 'restaurant.yukselyazilim.com', role: 'frontend', mode: 'public', url: 'https://restaurant.yukselyazilim.com/' }],
  asterisk: true
}

function ctr(p: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: 'x',
    name: 'yuksel-yazilim-frontend',
    image: 'img',
    state: 'running',
    status: 'Up 1 hour',
    health: null,
    restartCount: 0,
    lastRestartIncreaseAt: null,
    ports: '',
    cpuPct: 0,
    memBytes: 0,
    memPct: 0,
    ...p
  }
}

function healthy(): ServerState {
  return {
    serverId: 's1',
    connection: 'ready',
    errors: {},
    reach: { ts: 0, tcpOk: true, tcpMs: 5, sshOk: true, sshMs: 20, consecutiveFailures: 0 },
    host: {
      ts: 0,
      cpuPct: 10,
      cores: 4,
      load: [0.1, 0.1, 0.1],
      memTotal: 100,
      memUsed: 50,
      memPct: 50,
      swapTotal: 0,
      swapUsed: 0,
      uptimeSec: 1,
      disks: [{ fs: '/dev/sda1', mount: '/', size: 100, used: 40, avail: 60, pct: 40 }],
      memHighSince: null
    },
    docker: { ts: 0, available: true, containers: [ctr({})] },
    systemd: { ts: 0, units: [{ name: 'nginx', state: 'active' }], failed: [] },
    http: { h1: { checkId: 'h1', ts: 0, ok: true, status: 200, ms: 80 } },
    ssl: { 'restaurant.yukselyazilim.com': { host: 'restaurant.yukselyazilim.com', ts: 0, daysLeft: 60, authorized: true } },
    postgres: {},
    asterisk: {
      ts: 0,
      mode: 'full',
      activeChannels: 0,
      activeCalls: 0,
      callsProcessed: 0,
      registrations: [{ name: 'netgsm', status: 'Registered' }],
      endpoints: []
    }
  }
}

const NOW = 1_000_000_000

describe('evaluateServer', () => {
  it('sağlıklı durumda sorun yok', () => {
    expect(evaluateServer(server, [project], healthy(), th, NOW)).toEqual([])
  })

  it('docker stop → container çalışmıyor (crit, projeye bağlı)', () => {
    const st = healthy()
    st.docker!.containers = [ctr({ state: 'exited', status: 'Exited (0) 5 seconds ago' })]
    const i = evaluateServer(server, [project], st, th, NOW)
    expect(i).toEqual([expect.objectContaining({ key: 's1:ctr:yuksel-yazilim-frontend:state', severity: 'crit', projectId: 'p1' })])
  })

  it('unhealthy ve restart artışı', () => {
    const st = healthy()
    st.docker!.containers = [ctr({ health: 'unhealthy', status: 'Up (unhealthy)', lastRestartIncreaseAt: NOW - 1000, restartCount: 3 })]
    const keys = evaluateServer(server, [project], st, th, NOW).map((x) => x.key)
    expect(keys).toEqual(['s1:ctr:yuksel-yazilim-frontend:health', 's1:ctr:yuksel-yazilim-frontend:restart'])
  })

  it('container kaybolursa', () => {
    const st = healthy()
    st.docker!.containers = []
    expect(evaluateServer(server, [project], st, th, NOW)[0].key).toBe('s1:ctr:yuksel-yazilim-frontend:missing')
  })

  it('erişilemiyor: 2 ardışık başarısızlıktan sonra, diğer kontroller bastırılır', () => {
    const st = healthy()
    st.docker!.containers = []
    st.reach!.consecutiveFailures = 1
    expect(evaluateServer(server, [project], st, th, NOW).some((i) => i.key === 's1:unreachable')).toBe(false)
    st.reach!.consecutiveFailures = 2
    expect(evaluateServer(server, [project], st, th, NOW).map((i) => i.key)).toEqual(['s1:unreachable'])
  })

  it('disk %85 üstü warn, %95 üstü crit', () => {
    const st = healthy()
    st.host!.disks[0].pct = 86
    expect(evaluateServer(server, [project], st, th, NOW)[0]).toMatchObject({ key: 's1:disk:/', severity: 'warn' })
    st.host!.disks[0].pct = 96
    expect(evaluateServer(server, [project], st, th, NOW)[0].severity).toBe('crit')
  })

  it('RAM ancak 5 dakika boyunca yüksekse', () => {
    const st = healthy()
    st.host!.memPct = 93
    st.host!.memHighSince = NOW - 60_000
    expect(evaluateServer(server, [project], st, th, NOW)).toEqual([])
    st.host!.memHighSince = NOW - 301_000
    expect(evaluateServer(server, [project], st, th, NOW)[0].key).toBe('s1:ram')
  })

  it('HTTP 5xx / zaman aşımı', () => {
    const st = healthy()
    st.http.h1 = { checkId: 'h1', ts: 0, ok: false, status: 502, ms: 30, error: 'HTTP 502' }
    expect(evaluateServer(server, [project], st, th, NOW)[0]).toMatchObject({ key: 's1:http:h1', severity: 'crit' })
  })

  it('SSL 14 günden az', () => {
    const st = healthy()
    st.ssl['restaurant.yukselyazilim.com'].daysLeft = 10
    expect(evaluateServer(server, [project], st, th, NOW)[0]).toMatchObject({ severity: 'warn' })
    st.ssl['restaurant.yukselyazilim.com'].daysLeft = 1
    expect(evaluateServer(server, [project], st, th, NOW)[0]).toMatchObject({ severity: 'crit' })
  })

  it('pg_isready başarısız', () => {
    const st = healthy()
    const p = { ...project, postgres: { container: 'pg', user: 'postgres' } }
    st.postgres.p1 = { ts: 0, ready: false, connections: null, databases: [], error: 'no response' }
    expect(evaluateServer(server, [p], st, th, NOW)[0].key).toBe('s1:pg:p1')
  })

  it('Asterisk trunk kayıtlı değil (sadece tam modda)', () => {
    const st = healthy()
    st.asterisk!.registrations = [{ name: 'netgsm', status: 'Rejected' }]
    expect(evaluateServer(server, [project], st, th, NOW)[0].key).toBe('s1:ast:reg:netgsm')
    st.asterisk!.mode = 'limited'
    expect(evaluateServer(server, [project], st, th, NOW)).toEqual([])
  })

  it('systemd unit aktif değil', () => {
    const st = healthy()
    st.systemd!.units = [{ name: 'nginx', state: 'failed' }]
    st.systemd!.failed = ['nginx.service']
    const i = evaluateServer(server, [project], st, th, NOW)
    expect(i.map((x) => x.key)).toEqual(['s1:unit:nginx']) // --failed listesinde tekrar raporlanmaz
  })

  it('host key uyuşmazlığı', () => {
    const st = healthy()
    st.connection = 'hostkey-mismatch'
    expect(evaluateServer(server, [project], st, th, NOW).map((x) => x.key)).toEqual(['s1:hostkey'])
  })
})

describe('AlertEngine debounce', () => {
  const issue = { key: 'k', serverId: 's1', severity: 'crit' as const, title: 't' }

  it('sorun debounce süresi dolmadan açılmaz, dolunca bir kez açılır', () => {
    const e = new AlertEngine()
    expect(e.update([issue], 0, 10_000).opened).toHaveLength(0)
    expect(e.update([issue], 5_000, 10_000).opened).toHaveLength(0)
    const t = e.update([issue], 10_000, 10_000)
    expect(t.opened).toHaveLength(1)
    expect(t.opened[0].since).toBe(0)
    expect(e.update([issue], 15_000, 10_000).opened).toHaveLength(0)
    expect(e.activeIssues()).toHaveLength(1)
  })

  it('flapping: kısa süreli kaybolma ne bildirim ne kapanma üretir', () => {
    const e = new AlertEngine()
    e.update([issue], 0, 10_000)
    e.update([], 3_000, 10_000) // gitti → pending sıfırlanır
    expect(e.update([issue], 6_000, 10_000).opened).toHaveLength(0)
    expect(e.update([issue], 12_000, 10_000).opened).toHaveLength(0) // 6000'den itibaren sayılır
    expect(e.update([issue], 16_000, 10_000).opened).toHaveLength(1)
    // Aktifken kısa kaybolma kapatmaz
    expect(e.update([], 17_000, 10_000).resolved).toHaveLength(0)
    expect(e.update([issue], 20_000, 10_000).resolved).toHaveLength(0)
    expect(e.update([], 21_000, 10_000).resolved).toHaveLength(0)
    expect(e.update([], 31_000, 10_000).resolved).toHaveLength(1)
    expect(e.activeIssues()).toHaveLength(0)
  })

  it('warn → crit yükselmesi bildirilir', () => {
    const e = new AlertEngine()
    const w = { ...issue, severity: 'warn' as const }
    e.update([w], 0, 0)
    expect(e.update([issue], 1, 0).escalated).toHaveLength(1)
  })

  it('forget ile sunucu sorunları temizlenir', () => {
    const e = new AlertEngine()
    e.update([{ ...issue, key: 's1:x' }], 0, 0)
    e.forget('s1:')
    expect(e.activeIssues()).toEqual([])
  })
})
