import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CMD, buildScript, safeBackupFile, safeBackupRel, safeBackupSet, safeUnit, UnsafeInputError } from '../src/main/ssh/commands'
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
import { Maintenance, backupStamp, jobStamp } from '../src/main/maintenance'
import { Monitor } from '../src/main/monitor'
import { sanitizeMaintenance } from '../src/main/monitor'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { DEFAULT_SETTINGS, type MaintEvent, type ServerConfig, type ServerState } from '../src/shared/types'
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
    expect(isDumpComplete('\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc\n')).toBe(true)
    expect(isDumpComplete('COPY public.x (id) FROM stdin;')).toBe(false)
    expect(isDumpComplete('SELECT \'PostgreSQL database dump complete\';')).toBe(false)
  })

  it('upgrade poll çıktısını ayrıştırır', () => {
    expect(parseUpgradePoll('@@RC \n@@SIZE 120\nHit:1 http://archive\nGet:2 x')).toEqual({ rc: null, size: 120, chunk: 'Hit:1 http://archive\nGet:2 x' })
    expect(parseUpgradePoll('@@RC 0\n@@SIZE 4096\n')).toEqual({ rc: 0, size: 4096, chunk: '' })
    expect(parseUpgradePoll('çöp')).toEqual({ rc: null, size: null, chunk: '' })
  })
})

describe('bakım komutları', () => {
  const set = 'pg-2026-11-20_1830'

  it('lists databases and makes independent restore-compatible dumps', () => {
    expect(CMD.maintListDbs('pg', 'appuser')).toContain('psql -U appuser -d postgres -Atc "select datname from pg_database where not datistemplate order by 1"')
    const db = CMD.maintBackupDb(set, 'mydb', 'pg', 'appuser')
    expect(db).toMatch(/^bash -o pipefail -c '/)
    expect(db).toContain('pg_dump -C -U appuser -- mydb | gzip >')
    expect(db).toContain(`mkdir -p "$HOME/backups/${set}"`)
    expect(db).toContain(`if [ -e "$HOME/backups/${set}/mydb.sql.gz" ]`)
    expect(db).toContain(`rm -f "$HOME/backups/${set}/mydb.sql.gz"; exit 1`)
    const globals = CMD.maintBackupGlobals(set, 'pg', 'appuser')
    expect(globals).toMatch(/^bash -o pipefail -c '/)
    expect(globals).toContain('pg_dumpall --globals-only -U appuser | gzip >')
    expect(globals).toContain(`${set}/globals.sql.gz`)
    expect(buildScript(CMD.maintBackupVerify(`${set}/mydb.sql.gz`))).toContain(`sha256sum "$HOME/backups/${set}/mydb.sql.gz"`)
  })

  it('rejects unsafe database names, set IDs, and nested backup paths', () => {
    expect(safeBackupSet(set)).toBe(set)
    expect(safeBackupRel(`${set}/mydb.sql.gz`)).toBe(`${set}/mydb.sql.gz`)
    expect(safeBackupRel('restore-2026-11-20_183001.sql.gz')).toBeTruthy()
    for (const db of ['a;rm', '../x', '$(id)', 'a b', "a'b", '-x/abc', 'db\n']) {
      expect(() => CMD.maintBackupDb(set, db, 'pg', 'appuser')).toThrow(UnsafeInputError)
    }
    for (const dir of ['../x', '/pg-2026-11-20_1830', 'pg-2026-11-20_1830;rm', 'pg-2026-11-20_1830/x', `${set}\n`]) {
      expect(() => CMD.maintBackupDb(dir, 'app', 'pg', 'appuser')).toThrow(UnsafeInputError)
      expect(() => CMD.maintBackupGlobals(dir, 'pg', 'appuser')).toThrow(UnsafeInputError)
    }
    for (const rel of ['../x', `/${set}/app.sql.gz`, `${set}/../app.sql.gz`, `${set}/sub/app.sql.gz`, `${set}/a;rm.sql.gz`, `${set}/a..b.sql.gz`]) {
      expect(() => CMD.maintBackupVerify(rel)).toThrow(UnsafeInputError)
    }
    expect(() => CMD.maintListDbs('a;rm', 'postgres')).toThrow(UnsafeInputError)
    expect(() => CMD.maintBackupGlobals(set, 'pg', '$(id)')).toThrow(UnsafeInputError)
  })

  it('prunes sets and legacy files separately, preserving paths with spaces', () => {
    const cmd = CMD.maintBackupPrune()
    expect(cmd.match(/tail -n \+8/g)).toHaveLength(2)
    expect(cmd).toContain("-type d -name 'pg-*'")
    expect(cmd).toContain("-type f -name 'pg-*.sql.gz'")
    expect(cmd).toContain('rm -rv -- "$HOME/backups/$d"')
    expect(cmd).toContain('rm -v -- "$HOME/backups/$f"')
    expect(cmd).toContain('while IFS= read -r')
    expect(cmd).not.toContain('xargs')
  })

  it.skipIf(spawnSync('bash', ['--version']).status !== 0)('keeps the newest seven sets and seven legacy files by modification time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serverpulse prune '))
    const root = join(dir, 'backups')
    try {
      mkdirSync(root)
      for (let i = 1; i <= 10; i++) {
        // Reverse timestamp names so the assertion checks mtime, not name ordering.
        const set = `pg-2026-11-${String(21 - i).padStart(2, '0')}_1830`
        const folder = join(root, set)
        const legacy = join(root, `${set}.sql.gz`)
        mkdirSync(folder)
        writeFileSync(join(folder, 'db.sql.gz'), 'dump')
        writeFileSync(legacy, 'legacy dump')
        const time = new Date(2026, 10, i)
        utimesSync(folder, time, time)
        utimesSync(legacy, time, time)
      }
      mkdirSync(join(root, 'pg-unrecognized'))
      writeFileSync(join(root, 'pg-unrecognized.sql.gz'), 'keep')
      const quotedRoot = "'" + root.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"
      const cmd = `backup_test_root=${quotedRoot}; ` + CMD.maintBackupPrune().replaceAll('$HOME/backups', '$backup_test_root')
      const removed = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }).trim().split('\n')
      expect(removed).toHaveLength(6)
      expect(readdirSync(root)).toHaveLength(16)
      expect(existsSync(join(root, 'pg-2026-11-20_1830'))).toBe(false)
      expect(existsSync(join(root, 'pg-2026-11-20_1830.sql.gz'))).toBe(false)
      expect(existsSync(join(root, 'pg-2026-11-11_1830', 'db.sql.gz'))).toBe(true)
      expect(existsSync(join(root, 'pg-unrecognized'))).toBe(true)
      expect(execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates template unit names and generates bounded sudo-aware commands', () => {
    expect(safeUnit('worker@tenant-1.service')).toBe('worker@tenant-1.service')
    expect(safeUnit('x'.repeat(200))).toHaveLength(200)
    for (const unit of ['a;rm', '$(id)', 'a b', '../a', 'x'.repeat(201), '', 'nginx\n']) {
      expect(() => CMD.unitDiagnose(unit)).toThrow(UnsafeInputError)
      expect(() => CMD.unitRestart(unit)).toThrow(UnsafeInputError)
      expect(() => CMD.unitResetFailed(unit)).toThrow(UnsafeInputError)
    }
    expect(CMD.unitDiagnose('nginx.service').map((s) => s.name)).toEqual(['status', 'journal'])
    const certbot = buildScript(CMD.unitDiagnose('certbot.service'))
    expect(certbot).toContain('head -n 40')
    expect(certbot).toContain('-n 80 --no-pager')
    expect(certbot).toContain('tail -n 80 /var/log/letsencrypt/letsencrypt.log')
    expect(certbot).toContain('$S certbot certificates')
    expect(CMD.unitRestart('worker@tenant.service')).toContain('$S systemctl restart -- worker@tenant.service')
    expect(CMD.unitResetFailed('certbot.service')).toContain('sudo -n')
    expect(CMD.unitResetFailed('certbot.service')).toContain('$S systemctl reset-failed -- certbot.service')
  })

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
    expect(() => CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'pg; reboot', 'appuser')).toThrow()
    expect(() => CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'backend-postgres-1', '$(id)')).toThrow()
    expect(() => CMD.maintRestore('evil.sql.gz', 'backend-postgres-1', 'appuser')).toThrow()
    expect(() => CMD.pgEnvUser('a b')).toThrow()
    expect(() => CMD.maintUpgradeStart('20260930; id')).toThrow()
    expect(() => CMD.maintUpgradePoll(jobStamp(new Date()), -1)).toThrow()
  })

  it('yedek komutu pipefail kullanır ve hatada yarım dosyayı siler', () => {
    const c = CMD.maintBackup('pg-2026-09-30_0215.sql.gz', 'backend-postgres-1', 'appuser')
    expect(c).toMatch(/^bash -o pipefail -c '/)
    expect(c).toContain('docker exec backend-postgres-1 pg_dumpall -U appuser | gzip >')
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

describe('local backup sets', () => {
  it('reads manifests, directory fallbacks and legacy files, sorted by time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serverpulse-backups-'))
    try {
      const servers = [{ id: 's1', name: 'Primary' }, { id: 's2', name: 'Other', enabled: false }]
      const maint = new Maintenance({ config: { servers } } as unknown as Monitor, dir, () => {})
      expect(maint.listBackups('s1')).toEqual([])
      const root = maint.backupDir('s1')
      const latest = 'pg-2026-11-20_1830'
      const broken = 'pg-2026-11-19_183001'
      const noManifest = 'pg-2026-11-18_1830'
      for (const set of [latest, broken, noManifest]) mkdirSync(join(root, set), { recursive: true })
      writeFileSync(join(root, latest, 'app.sql.gz'), '12345')
      writeFileSync(join(root, latest, 'globals.sql.gz'), '123')
      writeFileSync(join(root, latest, 'manifest.json'), JSON.stringify({ ts: Date.now() + 10000, partial: true, dbs: [
        { db: 'app', file: `${latest}/app.sql.gz`, size: 5, sha: 'abc' }, { db: 'globals', file: `${latest}/globals.sql.gz`, size: 3, sha: 'abc' }
      ] }))
      writeFileSync(join(root, broken, 'old.sql.gz'), '12')
      writeFileSync(join(root, broken, 'manifest.json'), '{broken json')
      writeFileSync(join(root, noManifest, 'db.sql.gz'), '1')
      writeFileSync(join(root, 'pg-2026-11-17_1830.sql.gz'), '1234')
      writeFileSync(join(root, 'ignored.txt'), 'ignored')
      utimesSync(join(root, noManifest), new Date(1000), new Date(1000))
      const sets = maint.listBackups('s1')
      expect(sets).toHaveLength(4)
      expect(sets[0]).toMatchObject({ id: latest, legacy: false, partial: true, totalSize: 8 })
      expect(sets[0].files).toEqual(expect.arrayContaining([{ db: 'app', file: `${latest}/app.sql.gz`, size: 5 }]))
      expect(sets.find((s) => s.id === broken)).toMatchObject({ partial: true, totalSize: 2, ts: statSync(join(root, broken)).mtimeMs })
      expect(sets.at(-1)).toMatchObject({ id: noManifest, ts: 1000, partial: true, files: [{ db: 'db', file: `${noManifest}/db.sql.gz`, size: 1 }] })
      expect(sets.find((s) => s.legacy)).toMatchObject({ files: [{ db: 'all', file: 'pg-2026-11-17_1830.sql.gz', size: 4 }], totalSize: 4 })
      writeFileSync(join(dir, 'maintenance.log'), JSON.stringify({ serverId: 's1', step: 'backup', ok: true, ts: 1234 }) + '\n')
      expect(maint.listAllBackups()).toMatchObject([{ serverId: 's1', name: 'Primary', lastBackupAt: 1234 }, { serverId: 's2', name: 'Other', sets: [] }])
      for (const corrupt of ['null', '[]', '{"ts":"bad","dbs":[null]}']) {
        writeFileSync(join(root, broken, 'manifest.json'), corrupt)
        expect(maint.listBackups('s1')).toHaveLength(4)
      }
      writeFileSync(join(root, broken, 'manifest.json'), JSON.stringify({ ts: 2000, partial: true, dbs: [
        { db: 'outside', file: '../outside.sql.gz', size: 100 }
      ] }))
      expect(maint.listBackups('s1').find((s) => s.id === broken)?.files).toEqual([{ db: 'old', file: `${broken}/old.sql.gz`, size: 2 }])
      writeFileSync(join(root, broken, 'manifest.json'), JSON.stringify({ ts: 2000, partial: true, dbs: [
        { db: 'manifest-db', file: 'manifest-db.sql.gz', size: 99 }
      ] }))
      expect(maint.listBackups('s1').find((s) => s.id === broken)).toMatchObject({ ts: 2000, partial: true, totalSize: 99,
        files: [{ db: 'manifest-db', file: `${broken}/manifest-db.sql.gz`, size: 99 }] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backup all preconditions', () => {
  it('requires actions, confirms once, and skips servers without PostgreSQL without logging failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serverpulse-batch-'))
    const monitor = new Monitor(dir)
    try {
      const server: ServerConfig = { id: 's1', name: 'Primary', host: '127.0.0.1', port: 1, username: 'deploy', authType: 'key', systemdUnits: [], asterisk: false, prometheus: false, enabled: true }
      monitor.config.upsertServer(server)
      monitor.config.upsertServer({ ...server, id: 's2', name: 'Secondary' })
      monitor.config.upsertServer({ ...server, id: 's3', name: 'Disabled', enabled: false })
      const events: MaintEvent[] = []
      const maint = new Maintenance(monitor, dir, (e) => events.push(e))
      let confirmations = 0
      const confirm = async (): Promise<boolean> => { confirmations++; return true }
      expect(await maint.backupAll(confirm)).toMatchObject({ ok: false, results: [] })
      expect(confirmations).toBe(0)
      monitor.config.updateSettings({ allowActions: true })
      expect(await maint.backupAll(async () => false)).toEqual({ ok: false, cancelled: true, results: [] })
      expect(await maint.backupAll(confirm)).toMatchObject({ ok: true, results: [
        { serverId: 's1', status: 'skipped', dbs: 0 }, { serverId: 's2', status: 'skipped', dbs: 0 }
      ] })
      expect(confirmations).toBe(1)
      expect(events).toEqual([])
      expect(existsSync(join(dir, 'maintenance.log'))).toBe(false)
      expect(maint.lastBackupAt('s1')).toBeUndefined()
    } finally {
      monitor.stop()
      rmSync(dir, { recursive: true, force: true })
    }
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
