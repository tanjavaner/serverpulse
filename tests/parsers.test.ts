import { describe, expect, it } from 'vitest'
import { fx } from './helpers'
import { cpuPercent, parseDf, parseHost, parseLoadavg, parseMeminfo, parseProcStat, parseUptime } from '../src/main/parsers/host'
import {
  healthFromStatus,
  mergeDocker,
  parseDockerPs,
  parseDockerStats,
  parseInspectLines,
  parseLabels,
  parsePublishedPorts,
  parseSize,
  parseSystemDf,
  isDockerPermissionError
} from '../src/main/parsers/docker'
import {
  parseChannelsCount,
  parseCurl,
  parseDbSizes,
  parseEndpoints,
  parseFailedUnits,
  parseIsActive,
  parseNginxSites,
  parsePgIsReady,
  parseRegistrations,
  parseRunningUnits,
  parseSingleInt,
  parseSsListen,
  isSudoDenied
} from '../src/main/parsers/misc'
import { parseSections } from '../src/main/ssh/commands'

describe('host', () => {
  it('/proc/loadavg', () => expect(parseLoadavg(fx('proc_loadavg.txt'))).toEqual([0.42, 0.35, 0.3]))
  it('/proc/uptime', () => expect(parseUptime(fx('proc_uptime.txt'))).toBeCloseTo(1289345.12))

  it('/proc/meminfo byte cinsinden', () => {
    const m = parseMeminfo(fx('proc_meminfo.txt'))
    expect(m.MemTotal).toBe(10170820 * 1024)
    expect(m.MemAvailable).toBe(5234120 * 1024)
    expect(m['Active(anon)']).toBe(3812340 * 1024)
  })

  it('iki /proc/stat örneğinden CPU yüzdesi', () => {
    const a = parseProcStat(fx('proc_stat_1.txt'))
    const b = parseProcStat(fx('proc_stat_2.txt'))
    // Δtotal = 200+50+1700+50+5+5 = 2010, Δidle = 1700+50 = 1750 → (2010-1750)/2010
    expect(cpuPercent(a, b)).toBeCloseTo((260 / 2010) * 100, 3)
    expect(cpuPercent(null, b)).toBeNull()
    expect(cpuPercent(b, b)).toBeNull()
  })

  it('df -P -B1', () => {
    const d = parseDf(fx('df.txt'))
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({ fs: '/dev/sda1', mount: '/', size: 61255614464, pct: 40 })
    expect(d[1].mount).toBe('/boot/efi')
  })

  it('bölümleri birleştirir', () => {
    const out = [
      ['loadavg', 'proc_loadavg.txt'],
      ['meminfo', 'proc_meminfo.txt'],
      ['uptime', 'proc_uptime.txt'],
      ['stat', 'proc_stat_2.txt'],
      ['nproc', 'nproc.txt'],
      ['df', 'df.txt']
    ]
      .map(([n, f]) => `@@S ${n}\n${fx(f).trimEnd()}\n@@RC 0`)
      .join('\n')
    const { metrics } = parseHost(parseSections(out), parseProcStat(fx('proc_stat_1.txt')), 1000)
    expect(metrics.cores).toBe(4)
    expect(metrics.memPct).toBeCloseTo(((10170820 - 5234120) / 10170820) * 100, 3)
    expect(metrics.swapUsed).toBe((2097148 - 1983212) * 1024)
    expect(metrics.cpuPct).toBeGreaterThan(0)
    expect(metrics.disks[0].pct).toBe(40)
  })
})

describe('docker', () => {
  it('label ayrıştırma (değerde = ve , olabilir)', () => {
    const l = parseLabels('com.docker.compose.project=backend,desc=a=b,c,com.docker.compose.service=api')
    expect(l['com.docker.compose.project']).toBe('backend')
    expect(l['com.docker.compose.service']).toBe('api')
    expect(l.desc).toBe('a=b,c')
  })

  it('docker ps: 8 container, compose projesi ve health', () => {
    const ps = parseDockerPs(fx('docker_ps.jsonl'))
    expect(ps).toHaveLength(8)
    const api = ps.find((c) => c.name === 'backend-api-1')!
    expect(api.health).toBe('healthy')
    expect(api.composeProject).toBe('backend')
    expect(api.workingDir).toBe('/opt/apps/voice_assistant/backend')
    expect(ps.every((c) => c.state === 'running')).toBe(true)
  })

  it('boyut ve health çözümleme', () => {
    expect(parseSize('208.4MiB')).toBeCloseTo(208.4 * 1024 * 1024)
    expect(parseSize('1.2GB')).toBe(1.2e9)
    expect(parseSize('0B')).toBe(0)
    expect(parseSize('garbage')).toBeNull()
    expect(healthFromStatus('Up 2 hours (unhealthy)')).toBe('unhealthy')
    expect(healthFromStatus('Up 5 seconds (health: starting)')).toBe('starting')
    expect(healthFromStatus('Exited (1) 3 minutes ago')).toBeNull()
  })

  it('stats + inspect birleştirme ve restart artışı tespiti', () => {
    const ps = parseDockerPs(fx('docker_ps.jsonl'))
    const stats = parseDockerStats(fx('docker_stats.jsonl'))
    const ins = parseInspectLines(fx('docker_inspect.txt'))
    const prev = new Map([['voice-assistant-telephony', { restartCount: 1, lastRestartIncreaseAt: null }]])
    const merged = mergeDocker(ps, stats, ins, prev, 5000)
    const tel = merged.find((c) => c.name === 'voice-assistant-telephony')!
    expect(tel.restartCount).toBe(2)
    expect(tel.lastRestartIncreaseAt).toBe(5000)
    expect(tel.cpuPct).toBeCloseTo(3.4)
    const fe = merged.find((c) => c.name === 'example-frontend')!
    expect(fe.memBytes).toBeCloseTo(7.8 * 1024 * 1024)
    expect(fe.lastRestartIncreaseAt).toBeNull()
  })

  it('yayınlanan portlar', () => {
    expect(parsePublishedPorts('127.0.0.1:8082->8000/tcp')).toEqual([{ ip: '127.0.0.1', port: 8082 }])
    expect(parsePublishedPorts('9187/tcp')).toEqual([])
    expect(parsePublishedPorts('0.0.0.0:80->80/tcp, [::]:80->80/tcp')).toEqual([{ ip: '0.0.0.0', port: 80 }])
  })

  it('docker system df', () => {
    const df = parseSystemDf(fx('docker_system_df.jsonl'))
    expect(df.map((d) => d.type)).toEqual(['Images', 'Containers', 'Local Volumes', 'Build Cache'])
    expect(df[0]).toMatchObject({ total: 14, active: 8, size: '5.4GB' })
  })

  it('docker izin hatasını tanır', () => {
    expect(
      isDockerPermissionError(
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied'
      )
    ).toBe(true)
  })
})

describe('systemd', () => {
  it('is-active sırayla eşleştirilir', () => {
    const units = ['nginx', 'docker', 'asterisk', 'fail2ban', 'tailscaled', 'node_exporter']
    const r = parseIsActive(units, fx('systemctl_is_active.txt'))
    expect(r.map((u) => u.state)).toEqual(['active', 'active', 'inactive', 'active', 'failed', 'activating'])
  })
  it('--failed', () => expect(parseFailedUnits(fx('systemctl_failed.txt'))).toEqual(['certbot.service', 'logrotate.service']))
  it('--failed boş', () => expect(parseFailedUnits('')).toEqual([]))
  it('çalışan servisler', () => {
    const r = parseRunningUnits(fx('systemctl_running.txt'))
    expect(r).toContain('asterisk')
    expect(r).toContain('node_exporter')
    expect(r).toHaveLength(13)
  })
})

describe('curl', () => {
  it('başarılı', () => expect(parseCurl('200 0.012345', 0)).toEqual({ ok: true, status: 200, ms: 12, error: undefined }))
  it('404 sağlıklı sayılır (5xx değil)', () => expect(parseCurl('404 0.003', 0).ok).toBe(true))
  it('502', () => expect(parseCurl('502 0.1', 0)).toMatchObject({ ok: false, status: 502 }))
  it('bağlantı reddi', () => expect(parseCurl('000 0.000123', 7)).toMatchObject({ ok: false, error: 'Bağlantı reddedildi' }))
  it('zaman aşımı', () => expect(parseCurl('000 5.001', 28)).toMatchObject({ ok: false, error: 'Zaman aşımı' }))
  it('anlamsız çıktı', () => expect(parseCurl('bash: curl: command not found', 127).ok).toBe(false))
})

describe('postgres', () => {
  const s = parseSections(fx('pg.txt'))
  it('pg_isready', () => {
    expect(parsePgIsReady(s.ready.out, s.ready.rc)).toBe(true)
    expect(parsePgIsReady('/var/run/postgresql:5432 - no response', 2)).toBe(false)
    expect(parsePgIsReady('Error: No such container: x', 1)).toBe(false)
    expect(parsePgIsReady('', null)).toBeNull()
  })
  it('bağlantı sayısı ve DB boyutları', () => {
    expect(parseSingleInt(s.conns.out)).toBe(14)
    expect(parseDbSizes(s.sizes.out)).toEqual([
      { name: 'postgres', size: 7533103 },
      { name: 'restaurant', size: 48213555 }
    ])
  })
})

describe('asterisk', () => {
  it('core show channels count', () => {
    expect(parseChannelsCount(fx('asterisk_channels.txt'))).toEqual({ activeChannels: 2, activeCalls: 1, callsProcessed: 1543 })
  })
  it('pjsip show registrations', () => {
    expect(parseRegistrations(fx('asterisk_registrations.txt'))).toEqual([
      { name: 'siptrunk-trunk/sip:sip.provider.example:5060', status: 'Registered' },
      { name: 'backup-trunk/sip:sip.example.net', status: 'Rejected' }
    ])
  })
  it('pjsip show endpoints', () => {
    expect(parseEndpoints(fx('asterisk_endpoints.txt'))).toEqual([
      { name: '1001', state: 'Not in use' },
      { name: 'siptrunk-trunk', state: 'In use' },
      { name: 'backup-trunk', state: 'Unavailable' }
    ])
  })
  it('sudo reddini tanır', () => {
    expect(isSudoDenied('sudo: a password is required')).toBe(true)
    expect(isSudoDenied('2 active channels')).toBe(false)
  })
})

describe('ss ve nginx', () => {
  it('ss -tlnH', () => {
    const r = parseSsListen(fx('ss_tln.txt'))
    expect(r).toContainEqual({ addr: '127.0.0.1', port: 8082 })
    expect(r).toContainEqual({ addr: '100.64.0.10', port: 9100 })
    expect(r).toContainEqual({ addr: '::', port: 22 })
  })

  it('nginx server blokları: domain → proxy portu', () => {
    const b = parseNginxSites(fx('nginx_sites.txt'))
    const api = b.find((x) => x.serverNames.includes('api-restaurant.example.com') && x.ssl)!
    expect(api.proxyPorts).toEqual([8081])
    const web = b.find((x) => x.serverNames.includes('restaurant.example.com'))!
    expect(web.serverNames).toEqual(['restaurant.example.com', 'www.example.com'])
    expect(web.proxyPorts).toEqual([8080, 8081]) // yorum satırındaki 9999 dahil edilmez
    expect(web.primaryPort).toBe(8080) // location / hedefi
    expect(api.primaryPort).toBe(8081)
    expect(web.ssl).toBe(true)
    expect(b.some((x) => x.serverNames.includes('_'))).toBe(false)
  })
})
