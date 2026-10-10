import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ServerConfig, type ServerState } from '../src/shared/types'
import {
  isPublicBind,
  parseAuthFailures,
  parseInodes,
  parseListenPorts,
  parseNoLogRotation,
  parseProcesses,
  parseSshdConfig
} from '../src/main/parsers/insight'
import { netRate, parseNetDev } from '../src/main/parsers/host'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { CMD } from '../src/main/ssh/commands'
import { t } from '../src/shared/i18n'

describe('süreçler', () => {
  it('ps çıktısı: başlık atlanır, boşluklu komut adı korunur, rss KB → bayt', () => {
    const out = [
      '    PID USER     %CPU %MEM   RSS     ELAPSED COMMAND',
      '   1234 root     12.5  3.2 131072    01:02:03 dockerd',
      '    987 postgres  0.4  1.0  20480 5-03:10:00 tmux: server'
    ].join('\n')
    expect(parseProcesses(out)).toEqual([
      { pid: 1234, user: 'root', cpuPct: 12.5, memPct: 3.2, rssBytes: 131072 * 1024, elapsed: '01:02:03', command: 'dockerd' },
      { pid: 987, user: 'postgres', cpuPct: 0.4, memPct: 1, rssBytes: 20480 * 1024, elapsed: '5-03:10:00', command: 'tmux: server' }
    ])
  })

  it('hata çıktısı boş liste verir', () => {
    expect(parseProcesses('ps: unrecognized option')).toEqual([])
  })
})

describe('depolama', () => {
  it('df -P -i: inode desteklemeyen dosya sistemleri atlanır', () => {
    const out = [
      'Filesystem      Inodes   IUsed   IFree IUse% Mounted on',
      '/dev/vda1      3200000 3104000   96000   97% /',
      '/dev/vda15           0       0       0     - /boot/efi',
      '/dev/vdb1       655360    6553  648807    1% /mnt/data disk'
    ].join('\n')
    expect(parseInodes(out)).toEqual([
      { mount: '/', total: 3200000, used: 3104000, pct: 97 },
      { mount: '/mnt/data disk', total: 655360, used: 6553, pct: 1 }
    ])
  })

  it('max-size tanımsız json-file container’ları listelenir', () => {
    const out = ['/web|json-file|10m', '/db|json-file|<no value>', '/api|local|', '/worker|json-file|', 'çöp satır'].join('\n')
    expect(parseNoLogRotation(out)).toEqual(['db', 'worker'])
  })
})

describe('ağ trafiği', () => {
  const dev = (eth0Rx: number, eth0Tx: number): string =>
    [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0',
      `  eth0:${eth0Rx} 50 0 0 0 0 0 0 ${eth0Tx} 70 0 0 0 0 0 0`,
      'docker0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0',
      'vethabc: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0',
      'tailscale0: 900 9 0 0 0 0 0 0 900 9 0 0 0 0 0 0',
      '  ens3: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0'
    ].join('\n')

  it('loopback, docker, veth ve VPN arayüzleri sayılmaz', () => {
    expect(parseNetDev(dev(5000, 7000))).toEqual({ rx: 6000, tx: 9000 })
    expect(parseNetDev('Inter-|   Receive')).toBeNull()
  })

  it('iki örnekten bayt/sn; sayaç sıfırlanırsa null', () => {
    const a = { ts: 0, ...parseNetDev(dev(5000, 7000))! }
    const b = { ts: 2000, ...parseNetDev(dev(11000, 16000))! }
    expect(netRate(a, b)).toEqual({ rx: 3000, tx: 4500 })
    expect(netRate(b, a)).toBeNull()
    expect(netRate(null, b)).toBeNull()
  })
})

describe('güvenlik', () => {
  it('başarısız girişler bağlantı başına bir kez sayılır, en çok deneyen IP önce', () => {
    const out = [
      'Invalid user admin from 203.0.113.5 port 40000',
      'Failed password for invalid user admin from 203.0.113.5 port 40000 ssh2',
      'Failed password for root from 203.0.113.5 port 40002 ssh2',
      'Failed publickey for deploy from 2001:db8::7 port 51000 ssh2'
    ].join('\n')
    expect(parseAuthFailures(out)).toEqual({
      readable: true,
      attempts: 3,
      topIps: [
        { ip: '203.0.113.5', count: 2 },
        { ip: '2001:db8::7', count: 1 }
      ]
    })
  })

  it('journal okunamıyorsa (systemd-journal grubu yok) "0 deneme" değil okunamıyor', () => {
    for (const msg of [
      'Hint: You are currently not seeing messages from other users and the system.',
      'No journal files were opened due to insufficient permissions.',
      'No journal files were found.'
    ]) {
      expect(parseAuthFailures(msg).readable).toBe(false)
    }
    expect(parseAuthFailures('')).toEqual({ readable: true, attempts: 0, topIps: [] })
  })

  it('sshd: ilk değer geçerli (.d dosyaları önce), değer yoksa OpenSSH varsayılanı', () => {
    expect(parseSshdConfig('PasswordAuthentication no\nPasswordAuthentication yes\nPermitRootLogin yes')).toEqual({
      passwordAuth: false,
      rootLogin: 'yes',
      fromDefaults: false
    })
    // sshd -T çıktısı küçük harflidir; klavye-etkileşimli giriş de şifre sayılır
    expect(parseSshdConfig('passwordauthentication no\nkbdinteractiveauthentication yes\npermitrootlogin without-password').passwordAuth).toBe(true)
    expect(parseSshdConfig('')).toEqual({ passwordAuth: true, rootLogin: 'prohibit-password', fromDefaults: true })
  })

  it('ss -tlnH: tekrarsız ve sıralı adresler, dışa açık olanlar ayırt edilir', () => {
    const out = [
      'LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*',
      'LISTEN 0      128          0.0.0.0:22        0.0.0.0:*',
      'LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*',
      'LISTEN 0      128             [::]:22           [::]:*',
      'LISTEN 0      511                *:80              *:*',
      'LISTEN 0      511                *:80              *:*'
    ].join('\n')
    const ports = parseListenPorts(out)
    expect(ports).toEqual(['*:80', '0.0.0.0:22', '127.0.0.1:5432', '127.0.0.53%lo:53', '[::]:22'])
    expect(ports.filter(isPublicBind)).toEqual(['*:80', '0.0.0.0:22', '[::]:22'])
  })
})

describe('görünürlük alarmları', () => {
  const th = DEFAULT_SETTINGS.thresholds
  const server: ServerConfig = {
    id: 's1',
    name: 'VDS',
    host: 'sunucu.ornek.com',
    port: 22,
    username: 'deploy',
    authType: 'key',
    hostKeyFingerprint: 'SHA256:x',
    systemdUnits: [],
    asterisk: false,
    prometheus: false,
    enabled: true
  }
  const base = (): ServerState => ({
    serverId: 's1',
    connection: 'ready',
    errors: {},
    reach: { ts: 0, tcpOk: true, tcpMs: 5, sshOk: true, sshMs: 20, consecutiveFailures: 0 },
    http: {},
    ssl: {},
    postgres: {}
  })

  it('inode kullanımı disk eşiğini aşarsa uyarı, %95 üstü kritik', () => {
    const st = base()
    st.storage = {
      ts: 0,
      inodes: [
        { mount: '/', total: 100, used: 97, pct: 97 },
        { mount: '/data', total: 100, used: 88, pct: 88 },
        { mount: '/boot', total: 100, used: 10, pct: 10 }
      ],
      noLogRotation: []
    }
    const issues = evaluateServer(server, [], st, th, 0)
    expect(issues.map((i) => [i.key, i.severity])).toEqual([
      ['s1:inode:/', 'crit'],
      ['s1:inode:/data', 'warn']
    ])
  })

  it('yeni port yalnızca taban varken alarm üretir; dışa açık olan ayrı başlık alır', () => {
    const st = base()
    st.security = {
      ts: 0,
      auth: { readable: true, attempts: 0, topIps: [] },
      sshd: { passwordAuth: false, rootLogin: 'no', fromDefaults: false },
      fail2ban: 'active',
      unattended: 'active',
      ports: ['0.0.0.0:22', '0.0.0.0:9999', '127.0.0.1:6379']
    }
    expect(evaluateServer(server, [], st, th, 0)).toEqual([])

    const issues = evaluateServer({ ...server, portBaseline: ['0.0.0.0:22'] }, [], st, th, 0)
    expect(issues.map((i) => i.key)).toEqual(['s1:port:0.0.0.0:9999', 's1:port:127.0.0.1:6379'])
    expect(issues.every((i) => i.severity === 'warn')).toBe(true)
    expect(issues.map((i) => i.title)).toEqual([t('alert.newPortPublic', { s: 'VDS', p: '0.0.0.0:9999' }), t('alert.newPort', { s: 'VDS', p: '127.0.0.1:6379' })])
  })
})

describe('hafif mod', () => {
  it('docker stats bölümü atlanabilir', () => {
    expect(CMD.docker(true).map((s) => s.name)).toEqual(['ps', 'stats', 'inspect'])
    expect(CMD.docker(false).map((s) => s.name)).toEqual(['ps', 'inspect'])
  })
})
