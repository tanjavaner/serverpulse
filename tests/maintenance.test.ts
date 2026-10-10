import { describe, expect, it } from 'vitest'
import { CMD, buildScript, safeBackupFile, UnsafeInputError } from '../src/main/ssh/commands'
import {
  containerStatusOk,
  expectedKernel,
  isDumpComplete,
  parseNoRestart,
  parsePsLines,
  parseRebootPkgs,
  parseUpgradable,
  parseUpgradePoll,
  parseRestoreOutput,
  summarizeRestoreErrors
} from '../src/main/parsers/maintenance'
import { backupStamp, jobStamp } from '../src/main/maintenance'
import { sanitizeMaintenance } from '../src/main/monitor'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { DEFAULT_SETTINGS, type ServerConfig, type ServerState } from '../src/shared/types'
import { fx } from './helpers'

describe('bakım parser’ları', () => {
  it('apt list --upgradable çıktısını ve güvenlik güncellemelerini ayırır', () => {
    const pkgs = parseUpgradable(fx('apt_upgradable.txt'))
    expect(pkgs).toHaveLength(7)
    expect(pkgs.filter((p) => p.security).map((p) => p.name)).toEqual(['libheif1', 'libssl3t64', 'openssl'])
    expect(pkgs.find((p) => p.name === 'docker-ce')).toMatchObject({ version: '5:28.5.1-1~ubuntu.24.04~noble', security: false })
    expect(parseUpgradable('Listing... Done\nWARNING: apt does not have a stable CLI interface.\n')).toEqual([])
  })

  it('reboot-required.pkgs içinden beklenen çekirdeği bulur', () => {
    const pkgs = parseRebootPkgs(fx('reboot_required_pkgs.txt'))
    expect(pkgs).toEqual(['linux-image-6.8.0-142-generic', 'linux-base'])
    expect(expectedKernel(pkgs)).toBe('6.8.0-142-generic')
    expect(expectedKernel(['linux-image-6.8.0-99-generic', 'linux-image-6.8.0-142-generic'])).toBe('6.8.0-142-generic')
    expect(expectedKernel(['libssl3t64'])).toBeUndefined()
    expect(parseRebootPkgs('')).toEqual([])
  })

  it('restart politikası "no" olan container’ları uyarı için döner', () => {
    expect(parseNoRestart(fx('restart_policies.txt'))).toEqual(['elated_hopper'])
    expect(parseNoRestart('/x \n')).toEqual(['x'])
  })

  it('docker ps satırlarını ve sağlık durumunu okur', () => {
    const ps = parsePsLines('backend-api-1|Up 2 minutes (healthy)|backend-api\nnode|Up 5 seconds|node:22-alpine\nbozuk\n')
    expect(ps.map((c) => c.name)).toEqual(['backend-api-1', 'node'])
    expect(containerStatusOk('Up 2 minutes (healthy)')).toBe(true)
    expect(containerStatusOk('Up 3 seconds')).toBe(true)
    expect(containerStatusOk('Up 3 seconds (health: starting)')).toBe(false)
    expect(containerStatusOk('Up 1 hour (unhealthy)')).toBe(false)
    expect(containerStatusOk('Exited (0) 2 minutes ago')).toBe(false)
  })

  it('pg_dumpall sonu işaretini tanır', () => {
    expect(isDumpComplete('\n--\n-- PostgreSQL database cluster dump complete\n--\n')).toBe(true)
    expect(isDumpComplete('COPY public.x (id) FROM stdin;')).toBe(false)
  })

  it('upgrade poll çıktısını ayrıştırır', () => {
    expect(parseUpgradePoll('@@RC \n@@SIZE 120\nHit:1 http://archive\nGet:2 x')).toEqual({ rc: null, size: 120, chunk: 'Hit:1 http://archive\nGet:2 x' })
    expect(parseUpgradePoll('@@RC 0\n@@SIZE 4096\n')).toEqual({ rc: 0, size: 4096, chunk: '' })
    expect(parseUpgradePoll('çöp')).toEqual({ rc: null, size: null, chunk: '' })
  })
})

describe('bakım komutları', () => {
  it('yedek dosya adlarını doğrular', () => {
    expect(safeBackupFile('pg-2026-09-30_0215.sql.gz')).toBe('pg-2026-09-30_0215.sql.gz')
    expect(safeBackupFile('restore-2026-09-30_021533.sql.gz')).toBeTruthy()
    for (const f of ['pg-2026-09-30_0215.sql.gz; rm -rf ~', '../pg-2026-09-30_0215.sql.gz', 'x.sql.gz', 'pg-$(id).sql.gz']) {
      expect(() => safeBackupFile(f)).toThrow(UnsafeInputError)
    }
    expect(backupStamp(new Date(2026, 8, 30, 2, 5, 9))).toBe('2026-09-30_0205')
    expect(safeBackupFile(`pg-${backupStamp(new Date())}.sql.gz`)).toBeTruthy()
    expect(safeBackupFile(`restore-${backupStamp(new Date(), true)}.sql.gz`)).toBeTruthy()
  })

  it('komut üreticileri geçersiz girdiyi reddeder', () => {
    expect(() => CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'pg; reboot', 'asistan')).toThrow()
    expect(() => CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'backend-postgres-1', '$(id)')).toThrow()
    expect(() => CMD.maintRestore('evil.sql.gz', 'backend-postgres-1', 'asistan')).toThrow()
    expect(() => CMD.pgEnvUser('a b')).toThrow()
    expect(() => CMD.maintUpgradeStart('20260930; id')).toThrow()
    expect(() => CMD.maintUpgradePoll(jobStamp(new Date()), -1)).toThrow()
  })

  it('yedek komutu pipefail kullanır ve hatada yarım dosyayı siler', () => {
    const c = CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'backend-postgres-1', 'asistan')
    expect(c).toMatch(/^bash -o pipefail -c '/)
    expect(c).toContain('docker exec backend-postgres-1 pg_dumpall -U asistan | gzip >')
    expect(c).toContain('rm -f "$HOME/backups/pg-2026-09-30_0215.sql.gz"')
    expect(CMD.maintBackupPrune()).toContain('tail -n +8')
  })

  it('upgrade oturumdan bağımsız, etkileşimsiz ve kilit beklemeli çalışır', () => {
    const c = CMD.maintUpgradeStart('20260930-021500')
    expect(c).toContain('setsid -f nohup bash -o pipefail')
    expect(c).not.toMatch(/ & /)
    expect(c).toContain('DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a')
    expect(c).toContain('--force-confold')
    expect(c).toContain('DPkg::Lock::Timeout=300')
    expect(c).toContain('sudo -n')
    expect(c).not.toContain('do-release-upgrade')
  })

  it('durum kontrolü salt okunurdur', () => {
    // "command -v apt-get" yalnızca varlık kontrolüdür, apt çalıştırmaz
    const s = buildScript(CMD.maintStatus()).replace(/command -v apt-get|sudo -n -l [a-z -]+/g, '')
    expect(s).not.toMatch(/apt-get|systemctl|\brm /)
  })
})

describe('bakım ayarı ve alarm susturma', () => {
  it('bakım ayarını temizler ve doğrular', () => {
    expect(sanitizeMaintenance({ pgContainer: ' backend-postgres-1 ', pgUser: '' })).toEqual({ pgContainer: 'backend-postgres-1' })
    expect(sanitizeMaintenance({ pgContainer: '', pgUser: '' })).toBeUndefined()
    expect(() => sanitizeMaintenance({ pgContainer: 'x;id' })).toThrow()
  })

  it('reboot sırasında erişilemiyor alarmı üretilmez (en fazla 10 dk)', () => {
    const server: ServerConfig = { id: 's1', name: 'VDS', host: '1.2.3.4', port: 22, username: 'deploy', authType: 'key', systemdUnits: [], asterisk: false, prometheus: false, enabled: true }
    const now = Date.now()
    const st: ServerState = {
      serverId: 's1',
      connection: 'error',
      reach: { ts: now, tcpOk: false, tcpMs: null, sshOk: false, sshMs: null, consecutiveFailures: 5 },
      http: {},
      ssl: {},
      postgres: {},
      errors: {}
    }
    expect(evaluateServer(server, [], st, DEFAULT_SETTINGS.thresholds, now).map((i) => i.key)).toContain('s1:unreachable')
    const silenced: ServerState = { ...st, maintenance: { step: 'reboot', since: now - 60_000 } }
    expect(evaluateServer(server, [], silenced, DEFAULT_SETTINGS.thresholds, now)).toEqual([])
    const expired: ServerState = { ...st, maintenance: { step: 'reboot', since: now - 11 * 60_000 } }
    expect(evaluateServer(server, [], expired, DEFAULT_SETTINGS.thresholds, now).map((i) => i.key)).toContain('s1:unreachable')
  })
})

describe('geri yükleme raporu', () => {
  const out = [
    '@@ERR',
    'psql:<stdin>:14: ERROR:  role "postgres" already exists',
    'psql:<stdin>:30: ERROR:  database "app" already exists',
    'psql:<stdin>:88: ERROR:  multiple primary keys for table "users" are not allowed',
    'psql:<stdin>:120: ERROR:  duplicate key value violates unique constraint "users_pkey"',
    '@@TAIL',
    'COPY 0',
    'ALTER TABLE'
  ].join('\n')

  it('hata ve son satırları ayırır', () => {
    const r = parseRestoreOutput(out)
    expect(r.errors).toHaveLength(4)
    expect(r.tail).toBe('COPY 0\nALTER TABLE')
  })

  it('"zaten var" hatalarını beklenen sayar, veri hatalarını gerçek hata sayar', () => {
    const s = summarizeRestoreErrors(parseRestoreOutput(out).errors)
    expect(s.expected).toBe(3)
    expect(s.real).toEqual(['psql:<stdin>:120: ERROR:  duplicate key value violates unique constraint "users_pkey"'])
  })

  it('işaretleyici yoksa tüm çıktı tail olur', () => {
    expect(parseRestoreOutput('bash: docker: command not found')).toEqual({ errors: [], tail: 'bash: docker: command not found' })
  })

  it('restore komutu hataları psql çıkış kodundan bağımsız raporlar', () => {
    const cmd = CMD.maintRestore('restore-2026-10-08_120000.sql.gz', 'pg', 'postgres')
    expect(cmd).toContain('@@ERR')
    expect(cmd).toContain('grep "ERROR:"')
    expect(() => CMD.maintRestore('restore-2026-10-08_120000.sql.gz', 'pg;rm', 'postgres')).toThrow(UnsafeInputError)
  })

  it('durum kontrolü dağıtım ve paket yöneticisini okur', () => {
    const names = CMD.maintStatus().map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['os', 'pkg']))
  })
})
