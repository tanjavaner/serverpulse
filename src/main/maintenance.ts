import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'ssh2'
import type { BackupInfo, MaintEvent, MaintResult, MaintStatus, MaintStep, PostcheckResult, ServerConfig } from '@shared/types'
import type { Monitor } from './monitor'
import { CMD, buildScript, parseSections, safeBackupFile } from './ssh/commands'
import { execOn, sftpTransfer, withTempConnection } from './ssh/connection'
import {
  containerStarting,
  containerStatusOk,
  expectedKernel,
  isDumpComplete,
  parseNoRestart,
  parsePsLines,
  parseRebootPkgs,
  parseUpgradable,
  parseUpgradePoll
} from './parsers/maintenance'
import { isPostgresImage } from './discovery/proposals'

export type Confirm = (message: string, okLabel: string) => Promise<boolean>

const MIN = 60_000
const BACKUP_KEEP_HOURS = 24
const TELEPHONY_WARNING = 'sesli-asistan-telephony üzerindeki aktif aramalar kopar; 1-3 dk kesinti olur.'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pad = (n: number): string => String(n).padStart(2, '0')

/** pg-YYYY-MM-DD_HHMM(SS) */
export function backupStamp(d: Date, seconds = false): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${seconds ? pad(d.getSeconds()) : ''}`
}

/** YYYYMMDD-HHMMSS */
export function jobStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

interface LogEntry {
  ts: number
  serverId: string
  server: string
  step: MaintStep
  ok: boolean
  summary: string
}

interface RebootCtx {
  expectedKernel?: string
  containers: string[]
}

/**
 * Sunucu bakım işleri: durum kontrolü, Postgres yedeği (+ PC'ye indirme), apt upgrade, reboot,
 * reboot sonrası kontrol, autoremove ve geri yükleme. Yıkıcı işler allowActions + native onay ister.
 * Her adımın sonucu userData/maintenance.log'a (JSONL) yazılır.
 */
export class Maintenance {
  private running = new Map<string, MaintStep>()
  private rebootCtx = new Map<string, RebootCtx>()
  private logPath: string

  constructor(
    private monitor: Monitor,
    private dataDir: string,
    private emit: (e: MaintEvent) => void
  ) {
    this.logPath = join(dataDir, 'maintenance.log')
  }

  backupDir(serverId: string): string {
    return join(this.dataDir, 'backups', serverId)
  }

  // ------------------------------------------------------------ yardımcılar

  private server(serverId: string): ServerConfig {
    const s = this.monitor.config.server(serverId)
    if (!s) throw new Error('Sunucu bulunamadı')
    return s
  }

  /** Uzun işler için kalıcı izleme bağlantısından bağımsız, ayrı SSH oturumu. */
  private session<T>(serverId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const server = this.server(serverId)
    const creds = this.monitor.secrets.get(serverId)
    if (!creds) throw new Error('Kayıtlı kimlik bilgisi yok')
    return withTempConnection(server, creds, server.hostKeyFingerprint, fn)
  }

  private line(serverId: string, step: MaintStep, line: string): void {
    this.emit({ serverId, step, line })
  }

  /** Parça parça gelen çıktıyı satırlara bölerek yayınlar. */
  private streamer(serverId: string, step: MaintStep): { push: (chunk: string) => void; flush: () => void; tail: string[] } {
    let buf = ''
    const tail: string[] = []
    const out = (l: string): void => {
      this.line(serverId, step, l)
      tail.push(l)
      if (tail.length > 40) tail.shift()
    }
    return {
      tail,
      push: (chunk) => {
        buf += chunk
        const parts = buf.split(/\r?\n/)
        buf = parts.pop() ?? ''
        for (const p of parts) out(p)
      },
      flush: () => {
        if (buf) out(buf)
        buf = ''
      }
    }
  }

  private requireActions(): void {
    if (!this.monitor.config.settings.allowActions) throw new Error('Yönetim eylemleri ayarlardan kapalı (Ayarlar → Yönetim eylemleri)')
  }

  private writeLog(serverId: string, step: MaintStep, ok: boolean, summary: string): void {
    const entry: LogEntry = { ts: Date.now(), serverId, server: this.monitor.config.server(serverId)?.name ?? serverId, step, ok, summary: summary.slice(0, 2000) }
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      console.error('maintenance.log yazılamadı:', (e as Error).message)
    }
  }

  lastBackupAt(serverId: string): number | undefined {
    if (!existsSync(this.logPath)) return undefined
    let last: number | undefined
    for (const l of readFileSync(this.logPath, 'utf8').split('\n')) {
      if (!l) continue
      try {
        const e = JSON.parse(l) as LogEntry
        if (e.serverId === serverId && e.step === 'backup' && e.ok) last = Math.max(last ?? 0, e.ts)
      } catch {
        /* bozuk satır */
      }
    }
    return last
  }

  /** Sunucu başına tek iş; sonuç loglanır ve renderer'a "bitti" olayı gönderilir. */
  private async run<T extends MaintResult>(serverId: string, step: MaintStep, fn: () => Promise<T>, onError: (error: string) => T): Promise<T> {
    const busy = this.running.get(serverId)
    if (busy) return onError(`Bu sunucuda zaten bir bakım işi sürüyor (${busy})`)
    this.running.set(serverId, step)
    if (step !== 'status') this.monitor.setMaintenance(serverId, step)
    let res: T
    try {
      res = await fn()
    } catch (e) {
      res = onError((e as Error).message)
    } finally {
      this.running.delete(serverId)
      if (step !== 'status') this.monitor.setMaintenance(serverId, null)
    }
    if (!res.cancelled) {
      this.writeLog(serverId, step, res.ok, res.ok ? (res.summary ?? 'başarılı') : `HATA: ${res.error ?? ''}`)
      if (!res.ok && res.error) this.line(serverId, step, `✕ ${res.error}`)
    }
    this.emit({ serverId, step, done: true, ok: res.ok })
    return res
  }

  /** Yedek hedefi: sunucu ayarı → projelerdeki PostgreSQL ayarı → otomatik tespit (POSTGRES_USER). */
  async resolvePg(serverId: string): Promise<{ container: string; user: string } | undefined> {
    const server = this.server(serverId)
    const fromProject = this.monitor.config.projectsOf(serverId).find((p) => p.postgres)?.postgres
    let container = server.maintenance?.pgContainer ?? fromProject?.container
    if (!container) {
      container = this.monitor.state(serverId)?.docker?.containers.find((c) => c.state === 'running' && isPostgresImage(c.image))?.name
    }
    if (!container) return undefined
    let user = server.maintenance?.pgUser ?? (fromProject?.container === container ? fromProject.user : undefined)
    if (!user) {
      try {
        const r = await this.monitor.execFor(serverId, buildScript(CMD.pgEnvUser(container)), 15000)
        const v = parseSections(r.stdout).pguser?.out.trim()
        if (v && /^[a-zA-Z0-9_.-]+$/.test(v)) user = v
      } catch {
        /* varsayılan */
      }
    }
    return { container, user: user ?? 'postgres' }
  }

  // ------------------------------------------------------------ durum kontrolü

  private async statusRaw(serverId: string): Promise<MaintStatus> {
    const r = await this.monitor.execFor(serverId, buildScript(CMD.maintStatus()), 90000)
    const sec = parseSections(r.stdout)
    const rebootPkgs = parseRebootPkgs(sec.reboot_pkgs?.out ?? '')
    let pg: MaintStatus['pg']
    try {
      pg = await this.resolvePg(serverId)
    } catch {
      pg = undefined
    }
    const res: MaintStatus = {
      ok: !!sec.kernel && sec.kernel.rc === 0,
      kernel: sec.kernel?.out.trim(),
      rebootRequired: sec.reboot?.out.trim() === 'yes',
      rebootPkgs,
      expectedKernel: expectedKernel(rebootPkgs),
      upgradable: parseUpgradable(sec.upgradable?.out ?? ''),
      uptime: sec.uptime?.out.trim(),
      diskRoot: sec.df?.out.trim(),
      containers: parsePsLines(sec.ps?.out ?? ''),
      noRestart: parseNoRestart(sec.policies?.out ?? ''),
      pg,
      lastBackupAt: this.lastBackupAt(serverId)
    }
    if (!res.ok) res.error = 'Durum okunamadı: ' + (r.stdout + r.stderr).trim().slice(0, 300)
    else if (sec.sudo?.rc !== 0) res.error = 'Uyarı: sudo şifresiz çalışmıyor (sudo -n true başarısız). Güncelleme ve reboot yapılamaz.'
    return res
  }

  async status(serverId: string): Promise<MaintStatus> {
    const fail = (error: string): MaintStatus => ({ ok: false, error, rebootRequired: false, rebootPkgs: [], upgradable: [], containers: [], noRestart: [] })
    if (this.running.get(serverId)) {
      // Başka iş sürerken de salt okunur kontrol yapılabilsin (kilide girmeden)
      try {
        return await this.statusRaw(serverId)
      } catch (e) {
        return fail((e as Error).message)
      }
    }
    return this.run<MaintStatus>(serverId, 'status', async () => {
      const s = await this.statusRaw(serverId)
      const sec = s.upgradable.filter((p) => p.security).length
      return { ...s, summary: `çekirdek ${s.kernel}, reboot ${s.rebootRequired ? 'gerekli' : 'gerekmiyor'}, ${s.upgradable.length} güncelleme (${sec} güvenlik)` }
    }, fail)
  }

  // ------------------------------------------------------------ yedek

  async backup(serverId: string, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'backup', async () => {
      this.requireActions()
      const server = this.server(serverId)
      const pg = await this.resolvePg(serverId)
      if (!pg) throw new Error('PostgreSQL container bulunamadı. Sunucu ayarlarından container/kullanıcı girin.')
      const ok = await confirm(
        `${server.name} üzerinde ${pg.container} (kullanıcı ${pg.user}) için pg_dumpall yedeği alınıp bu bilgisayara indirilsin mi?\n\nSunucuda ~/backups altında son 7 yedek tutulur, daha eskileri silinir.`,
        'Yedek al'
      )
      if (!ok) return { ok: false, cancelled: true }

      const file = safeBackupFile(`pg-${backupStamp(new Date())}.sql.gz`)
      const localDir = this.backupDir(serverId)
      mkdirSync(localDir, { recursive: true })
      const localPath = join(localDir, file)
      const log = (l: string): void => this.line(serverId, 'backup', l)

      return this.session(serverId, async (c) => {
        log(`pg_dumpall çalışıyor → ~/backups/${file}`)
        const dump = await execOn(c, CMD.maintBackup(file, pg.container, pg.user), 15 * MIN)
        if (dump.code !== 0) throw new Error(`pg_dumpall başarısız (çıkış ${dump.code}): ${(dump.stdout + dump.stderr).trim().slice(0, 500)}`)

        log('Doğrulanıyor (boyut, gunzip -t, dump sonu işareti, sha256)…')
        const v = parseSections((await execOn(c, buildScript(CMD.maintBackupVerify(file)), 5 * MIN)).stdout)
        const size = Number(v.size?.out.trim())
        if (!(size > 0)) throw new Error('Yedek dosyası boş')
        if (v.gunzip_t?.rc !== 0) throw new Error(`gunzip -t başarısız: ${v.gunzip_t?.out.trim()}`)
        if (!isDumpComplete(v.tail?.out ?? '')) throw new Error('Dump tamamlanmamış: "PostgreSQL database cluster dump complete" satırı yok')
        const remoteSha = v.sha?.out.trim() ?? ''
        const home = v.home?.out.trim()
        if (!home?.startsWith('/') || !/^[0-9a-f]{64}$/.test(remoteSha)) throw new Error('Sunucu yolu / sha256 okunamadı')
        log(`Sunucuda: ${size} bayt, sha256 ${remoteSha.slice(0, 16)}…`)

        log(`İndiriliyor → ${localPath}`)
        await sftpTransfer(c, 'get', `${home}/backups/${file}`, localPath)
        const localSize = statSync(localPath).size
        const localSha = await sha256File(localPath)
        if (localSize !== size || localSha !== remoteSha) {
          unlinkSync(localPath)
          throw new Error(`İndirilen dosya eşleşmiyor (boyut ${localSize}/${size}, sha256 ${localSha === remoteSha ? 'aynı' : 'farklı'})`)
        }
        log('✓ İndirilen dosyanın boyutu ve sha256 değeri sunucudakiyle aynı')

        const prune = await execOn(c, CMD.maintBackupPrune(), 60000)
        const removed = prune.stdout.split('\n').filter((l) => l.trim()).length
        log(removed ? `Sunucuda eski ${removed} yedek silindi` : 'Sunucuda silinecek eski yedek yok (≤ 7)')
        return { ok: true, summary: `${file} · ${size} bayt · sha256 ${remoteSha} · ${localPath}` }
      })
    }, (error) => ({ ok: false, error }))
  }

  listBackups(serverId: string): BackupInfo[] {
    const dir = this.backupDir(serverId)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => {
        const st = statSync(join(dir, f))
        return { file: f, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  }

  // ------------------------------------------------------------ güncelleme

  async upgrade(serverId: string, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'upgrade', async () => {
      this.requireActions()
      const server = this.server(serverId)
      const last = this.lastBackupAt(serverId)
      const noBackup = !last || Date.now() - last > BACKUP_KEEP_HOURS * 3600_000
      const ok = await confirm(
        `${server.name} üzerinde paketler güncellensin mi (apt-get update && upgrade)?\n\n` +
          'docker-ce güncellenirse tüm container\'lar kısa süre yeniden başlar.' +
          (noBackup ? '\n\n⚠ Son 24 saatte başarılı bir veritabanı yedeği yok.' : ''),
        'Güncelle'
      )
      if (!ok) return { ok: false, cancelled: true }
      const log = (l: string): void => this.line(serverId, 'upgrade', l)

      const sudo = await this.monitor.execFor(serverId, 'sudo -n true 2>&1', 20000)
      if (sudo.code !== 0) throw new Error(`sudo şifresiz çalışmıyor: ${sudo.stdout.trim()}`)

      const ts = jobStamp(new Date())
      const start = await this.monitor.execFor(serverId, CMD.maintUpgradeStart(ts), 30000)
      if (!start.stdout.includes('started')) throw new Error(`Güncelleme başlatılamadı: ${(start.stdout + start.stderr).trim()}`)
      log(`apt çalışıyor (sunucuda ~/serverpulse-maint/upgrade-${ts}.log)…`)

      const out = this.streamer(serverId, 'upgrade')
      const deadline = Date.now() + 30 * MIN
      let offset = 0
      let rc: number | null = null
      let failures = 0
      while (Date.now() < deadline) {
        await sleep(2000)
        try {
          const p = parseUpgradePoll((await this.monitor.execFor(serverId, CMD.maintUpgradePoll(ts, offset), 30000)).stdout)
          failures = 0
          if (p.size != null && p.size > offset) {
            out.push(p.chunk)
            offset = p.size
          }
          if (p.rc != null) {
            rc = p.rc
            break
          }
        } catch (e) {
          // Kısa kopmalar işi etkilemez (apt sunucuda bağımsız çalışıyor)
          if (++failures >= 30) throw new Error(`Sunucuya 1 dakikadır ulaşılamıyor: ${(e as Error).message}`)
        }
      }
      out.flush()
      if (rc == null) throw new Error('Güncelleme 30 dakikada bitmedi. Sunucuda log dosyasını kontrol edin.')
      if (rc !== 0) throw new Error(`apt-get çıkış kodu ${rc}`)

      const counts = out.tail.map((l) => /^(\d+) upgraded, (\d+) newly installed/.exec(l)).find(Boolean)
      log('— Container durumu —')
      const ps = await this.monitor.execFor(serverId, buildScript(CMD.maintStatus().filter((s) => s.name === 'ps')), 30000)
      for (const c of parsePsLines(parseSections(ps.stdout).ps?.out ?? '')) log(`${c.name}  ${c.status}`)
      this.monitor.refreshAll()
      return { ok: true, summary: counts ? `${counts[1]} paket güncellendi, ${counts[2]} yeni kuruldu` : 'apt upgrade tamamlandı' }
    }, (error) => ({ ok: false, error }))
  }

  // ------------------------------------------------------------ reboot

  async reboot(serverId: string, confirmText: string, confirm: Confirm): Promise<PostcheckResult> {
    const fail = (error: string): PostcheckResult => ({ ok: false, error, containers: [], missing: [] })
    return this.run<PostcheckResult>(serverId, 'reboot', async () => {
      this.requireActions()
      if (confirmText !== 'REBOOT') throw new Error('Onay metni hatalı (REBOOT yazılmalı)')
      const server = this.server(serverId)
      const log = (l: string): void => this.line(serverId, 'reboot', l)

      const pre = await this.statusRaw(serverId)
      if (!pre.ok) throw new Error(pre.error ?? 'Reboot öncesi durum okunamadı')
      const ctx: RebootCtx = { expectedKernel: pre.expectedKernel, containers: pre.containers.map((c) => c.name) }
      this.rebootCtx.set(serverId, ctx)
      const calls = this.monitor.state(serverId)?.asterisk?.activeCalls
      const ok = await confirm(
        `${server.name} YENİDEN BAŞLATILSIN MI?\n\n${TELEPHONY_WARNING}` +
          (calls != null ? `\nŞu an aktif çağrı: ${calls}` : '') +
          (pre.noRestart.length ? `\n\nRestart politikası "no" olan, reboot sonrası GELMEYECEK container'lar:\n• ${pre.noRestart.join('\n• ')}` : '') +
          (ctx.expectedKernel ? `\n\nBeklenen çekirdek: ${ctx.expectedKernel}` : ''),
        'Evet, yeniden başlat'
      )
      if (!ok) return { ok: false, cancelled: true, containers: [], missing: [] }

      log(`Reboot öncesi: çekirdek ${pre.kernel}, ${ctx.containers.length} çalışan container`)
      if (pre.noRestart.length) log(`⚠ Geri gelmeyecek container'lar: ${pre.noRestart.join(', ')}`)
      const rebootAt = Date.now()
      try {
        const r = await this.session(serverId, (c) => execOn(c, CMD.maintReboot(), 20000))
        if (r.code !== 0 && r.code !== null) throw new Error(`Reboot komutu başarısız: ${r.stdout.trim()}`)
      } catch (e) {
        // Bağlantının kopması beklenen durum; sadece komutun açıkça reddedilmesi hatadır
        if (/Reboot komutu başarısız/.test((e as Error).message)) throw e
      }
      log('Reboot komutu gönderildi. Sunucunun geri gelmesi bekleniyor (10 sn arayla, en fazla 5 dk)…')

      await sleep(15000)
      let back = false
      while (Date.now() - rebootAt < 5 * MIN + 15000) {
        try {
          const r = await this.session(serverId, (c) => execOn(c, 'cat /proc/uptime', 10000))
          const up = Number(r.stdout.trim().split(/\s+/)[0])
          // Eski oturum henüz kapanmadıysa uptime büyük olur; yeni açılış uptime'ı reboot'tan bu yana geçen süreden küçüktür
          if (Number.isFinite(up) && up < (Date.now() - rebootAt) / 1000 + 30) {
            back = true
            log(`✓ Sunucu geri geldi (uptime ${Math.round(up)} sn)`)
            break
          }
          log('Sunucu henüz kapanmadı…')
        } catch {
          log(`… bekleniyor (${Math.round((Date.now() - rebootAt) / 1000)} sn)`)
        }
        await sleep(10000)
      }
      if (!back) throw new Error('Sunucu 5 dakika içinde geri gelmedi. Sağlayıcı panelinden konsolu kontrol edin.')
      this.monitor.reconnect(serverId)

      log('— Reboot sonrası kontrol —')
      const pc = await this.postcheckRaw(serverId, 'reboot', ctx)
      return { ...pc, summary: `reboot tamam · ${pc.summary ?? ''}` }
    }, fail)
  }

  // ------------------------------------------------------------ reboot sonrası kontrol

  private async postcheckRaw(serverId: string, step: MaintStep, ctx: RebootCtx | undefined): Promise<PostcheckResult> {
    const log = (l: string): void => this.line(serverId, step, l)
    const deadline = Date.now() + 60_000
    let res: PostcheckResult
    for (;;) {
      const sec = parseSections((await this.monitor.execFor(serverId, buildScript(CMD.maintPostcheck()), 30000)).stdout)
      const kernel = sec.kernel?.out.trim()
      const ps = parsePsLines(sec.ps?.out ?? '')
      const byName = new Map(ps.map((c) => [c.name, c]))
      // Beklenen: reboot öncesi çalışanlar; bilinmiyorsa şu an çalışanlar (sadece health kontrolü)
      const expected = ctx?.containers.length ? ctx.containers : ps.filter((c) => /^Up\b/.test(c.status)).map((c) => c.name)
      const containers = expected.map((name) => {
        const c = byName.get(name)
        return { name, status: c?.status ?? 'yok', ok: !!c && containerStatusOk(c.status) }
      })
      const missing = containers.filter((c) => !c.ok).map((c) => c.name)
      const kernelOk = ctx?.expectedKernel ? kernel === ctx.expectedKernel : undefined
      const rebootRequired = sec.reboot?.out.trim() === 'yes'
      res = {
        ok: missing.length === 0 && kernelOk !== false && !rebootRequired,
        kernel,
        expectedKernel: ctx?.expectedKernel,
        kernelOk,
        rebootRequired,
        containers,
        missing
      }
      // Healthcheck "starting" ya da container henüz ayağa kalkmadıysa 60 sn'ye kadar bekle
      const pending = containers.some((c) => !c.ok && (c.status === 'yok' || containerStarting(c.status) || !/^Up\b/.test(c.status)))
      if (res.ok || !pending || Date.now() > deadline) break
      log(`${missing.length} container bekleniyor…`)
      await sleep(5000)
    }
    log(`Çekirdek: ${res.kernel}${res.expectedKernel ? (res.kernelOk ? ' ✓' : ` ✕ (beklenen ${res.expectedKernel})`) : ''}`)
    log(`reboot-required: ${res.rebootRequired ? '✕ hâlâ var' : '✓ yok'}`)
    for (const c of res.containers) log(`${c.ok ? '✓' : '✕'} ${c.name}  ${c.status}`)
    res.summary = `çekirdek ${res.kernel}, ${res.containers.length - res.missing.length}/${res.containers.length} container sağlıklı`
    if (!res.ok) {
      const why = [
        res.kernelOk === false ? `çekirdek ${res.kernel} (beklenen ${res.expectedKernel})` : '',
        res.rebootRequired ? 'reboot-required hâlâ var' : '',
        res.missing.length ? `sorunlu container: ${res.missing.join(', ')}` : ''
      ].filter(Boolean)
      res.error = why.join(' · ')
    }
    this.monitor.refreshAll()
    return res
  }

  async postcheck(serverId: string): Promise<PostcheckResult> {
    return this.run<PostcheckResult>(serverId, 'postcheck', () => this.postcheckRaw(serverId, 'postcheck', this.rebootCtx.get(serverId)), (error) => ({
      ok: false,
      error,
      containers: [],
      missing: []
    }))
  }

  // ------------------------------------------------------------ autoremove

  async autoremove(serverId: string, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'autoremove', async () => {
      this.requireActions()
      const server = this.server(serverId)
      const kernel = (await this.monitor.execFor(serverId, 'uname -r', 15000)).stdout.trim()
      const ok = await confirm(`${server.name} üzerinde "apt-get autoremove" çalıştırılsın mı?\n\nKullanılmayan paketler ve eski çekirdekler silinir. Çalışan çekirdek: ${kernel}`, 'Temizle')
      if (!ok) return { ok: false, cancelled: true }
      const out = this.streamer(serverId, 'autoremove')
      const r = await this.monitor.execFor(serverId, CMD.maintAutoremove(), 15 * MIN)
      out.push(r.stdout + r.stderr)
      out.flush()
      if (r.code !== 0) throw new Error(`apt-get autoremove çıkış kodu ${r.code}`)
      const m = /(\d+) to remove/.exec(r.stdout)
      return { ok: true, summary: m ? `${m[1]} paket kaldırıldı` : 'autoremove tamamlandı' }
    }, (error) => ({ ok: false, error }))
  }

  // ------------------------------------------------------------ geri yükleme

  async restore(serverId: string, confirmText: string, localPath: string | null, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'restore', async () => {
      this.requireActions()
      if (confirmText !== 'RESTORE') throw new Error('Onay metni hatalı (RESTORE yazılmalı)')
      if (!localPath) return { ok: false, cancelled: true }
      if (!localPath.endsWith('.sql.gz') || !existsSync(localPath)) throw new Error('Bir .sql.gz yedek dosyası seçilmeli')
      const server = this.server(serverId)
      const pg = await this.resolvePg(serverId)
      if (!pg) throw new Error('PostgreSQL container bulunamadı')
      const ok = await confirm(
        `DİKKAT: ${server.name} üzerindeki ${pg.container} veritabanına\n${localPath}\ngeri yüklensin mi?\n\nMevcut veriler bu yedekteki içerikle değiştirilebilir. Bu işlem geri alınamaz.`,
        'Evet, geri yükle'
      )
      if (!ok) return { ok: false, cancelled: true }
      const log = (l: string): void => this.line(serverId, 'restore', l)
      const file = safeBackupFile(`restore-${backupStamp(new Date(), true)}.sql.gz`)

      return this.session(serverId, async (c) => {
        const home = (await execOn(c, 'mkdir -p "$HOME/backups" && printf "%s" "$HOME"', 20000)).stdout.trim()
        if (!home.startsWith('/')) throw new Error('Sunucudaki ev dizini okunamadı')
        log(`Yükleniyor → ~/backups/${file}`)
        await sftpTransfer(c, 'put', `${home}/backups/${file}`, localPath)
        const v = parseSections((await execOn(c, buildScript(CMD.maintBackupVerify(file)), 5 * MIN)).stdout)
        if (v.gunzip_t?.rc !== 0 || !isDumpComplete(v.tail?.out ?? '')) {
          await execOn(c, `rm -f "$HOME/backups/${file}"`, 20000)
          throw new Error('Dosya bozuk ya da tamamlanmamış bir pg_dumpall yedeği')
        }
        log('psql ile geri yükleniyor (mevcut rol/DB uyarıları normaldir)…')
        const r = await execOn(c, CMD.maintRestore(file, pg.container, pg.user), 30 * MIN)
        const out = this.streamer(serverId, 'restore')
        out.push(r.stdout + r.stderr)
        out.flush()
        if (r.code !== 0) throw new Error(`Geri yükleme çıkış kodu ${r.code}`)
        this.monitor.refreshAll()
        return { ok: true, summary: `${localPath} → ${pg.container}` }
      })
    }, (error) => ({ ok: false, error }))
  }
}
