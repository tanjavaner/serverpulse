import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'ssh2'
import type { BackupInfo, ContainerInfo, MaintEvent, MaintResult, MaintStatus, MaintStep, PostcheckResult, ProjectConfig, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import type { Monitor } from './monitor'
import { CMD, buildScript, parseSections, safeBackupFile } from './ssh/commands'
import { execOn, sftpTransfer, withTempConnection } from './ssh/connection'
import {
  containerStarting,
  containerStatusOk,
  expectedKernel,
  isDumpComplete,
  parseNoRestart,
  parseRestoreOutput,
  parsePsLines,
  parseRebootPkgs,
  parseUpgradable,
  parseUpgradePoll,
  summarizeRestoreErrors
} from './parsers/maintenance'
import { isPostgresImage } from './discovery/proposals'

export type Confirm = (message: string, okLabel: string) => Promise<boolean>

/**
 * Projenin container'larından compose projesini çıkarır. Tümü tek bir compose projesine ait olmalı;
 * dizin ve dosyalar etiketlerden gelir (komut tarafında ayrıca doğrulanır).
 */
export function composeSpec(project: ProjectConfig, containers: ContainerInfo[]): { project: string; dir: string; files: string[] } {
  const own = containers.filter((c) => project.containers.includes(c.name) && c.composeProject)
  const names = [...new Set(own.map((c) => c.composeProject!))]
  if (names.length === 0) throw new Error(t('mm.noComposeLabels'))
  if (names.length > 1) throw new Error(t('mm.multiCompose', { list: names.join(', ') }))
  const ref = own.find((c) => c.workingDir) ?? own[0]
  if (!ref.workingDir) throw new Error(t('mm.noComposeLabels'))
  return { project: names[0], dir: ref.workingDir, files: ref.composeFiles ?? [] }
}

const MIN = 60_000
const BACKUP_KEEP_HOURS = 24
/** Sunucunun reboot komutunu açıkça reddetmesi (bağlantının kopması ise beklenen durumdur). */
class RebootRejectedError extends Error {}

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
    if (!s) throw new Error(t('err.serverNotFound'))
    return s
  }

  /** Uzun işler için kalıcı izleme bağlantısından bağımsız, ayrı SSH oturumu. */
  private session<T>(serverId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const server = this.server(serverId)
    const creds = this.monitor.credsFor(serverId)
    if (!creds) throw new Error(t('err.noCreds'))
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
    if (!this.monitor.config.settings.allowActions) throw new Error(t('err.actionsDisabled'))
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
    if (busy) return onError(t('mm.busy', { s: t(`maint.step.${busy}`) }))
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
      this.writeLog(serverId, step, res.ok, res.ok ? (res.summary ?? t('mm.success')) : t('mm.errorPrefix', { e: res.error ?? '' }))
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
      os: sec.os?.out.trim() || undefined,
      pkgManager: sec.pkg?.out.trim() === 'apt' ? 'apt' : sec.pkg ? 'unsupported' : undefined,
      rebootRequired: sec.reboot?.out.trim() === 'yes',
      rebootPkgs,
      expectedKernel: expectedKernel(rebootPkgs),
      upgradable: parseUpgradable(sec.upgradable?.out ?? ''),
      uptime: sec.uptime?.out.trim(),
      diskRoot: sec.df?.out.trim(),
      containers: parsePsLines(sec.ps?.out ?? ''),
      noRestart: parseNoRestart(sec.policies?.out ?? ''),
      sudoApt: sec.sudo_apt ? sec.sudo_apt.rc === 0 : undefined,
      sudoReboot: sec.sudo_reboot ? sec.sudo_reboot.rc === 0 : undefined,
      pg,
      lastBackupAt: this.lastBackupAt(serverId)
    }
    if (!res.ok) res.error = t('mm.statusUnreadable', { e: (r.stdout + r.stderr).trim().slice(0, 300) })
    else {
      const warnings = [
        res.pkgManager === 'unsupported' ? t('mm.noApt', { os: res.os ?? t('mm.unknownDistro') }) : '',
        res.pkgManager === 'apt' && res.sudoApt === false ? t('mm.noSudoApt') : '',
        res.sudoReboot === false ? t('mm.noSudoReboot') : ''
      ].filter(Boolean)
      if (warnings.length) res.error = t('mm.warning', { w: warnings.join(' ') })
    }
    return res
  }

  /** Paket işlemleri yalnızca apt'li sistemlerde: diğer dağıtımlarda yanıltıcı "0 güncelleme" yerine açık hata. */
  private async requireApt(serverId: string): Promise<void> {
    const r = await this.monitor.execFor(serverId, buildScript(CMD.maintStatus().filter((s) => s.name === 'pkg' || s.name === 'os')), 20000)
    const sec = parseSections(r.stdout)
    if (sec.pkg?.out.trim() !== 'apt') {
      throw new Error(t('mm.noApt', { os: sec.os?.out.trim() || t('mm.unknownDistro') }))
    }
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
      return {
        ...s,
        summary: t('mm.statusSummary', { k: s.kernel, r: s.rebootRequired ? t('mm.rebootReq') : t('mm.rebootNotReq'), n: s.upgradable.length, s: sec })
      }
    }, fail)
  }

  // ------------------------------------------------------------ yedek

  async backup(serverId: string, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'backup', async () => {
      this.requireActions()
      const server = this.server(serverId)
      const pg = await this.resolvePg(serverId)
      if (!pg) throw new Error(t('mm.noPg'))
      const ok = await confirm(t('mm.backupConfirm', { s: server.name, c: pg.container, u: pg.user }), t('mm.backupOk'))
      if (!ok) return { ok: false, cancelled: true }

      const file = safeBackupFile(`pg-${backupStamp(new Date())}.sql.gz`)
      const localDir = this.backupDir(serverId)
      mkdirSync(localDir, { recursive: true })
      const localPath = join(localDir, file)
      const log = (l: string): void => this.line(serverId, 'backup', l)

      return this.session(serverId, async (c) => {
        log(t('mm.dumpRunning', { f: file }))
        const dump = await execOn(c, CMD.maintBackup(file, pg.container, pg.user), 15 * MIN)
        if (dump.code !== 0) throw new Error(t('mm.dumpFailed', { c: dump.code, e: (dump.stdout + dump.stderr).trim().slice(0, 500) }))

        log(t('mm.verifying'))
        const v = parseSections((await execOn(c, buildScript(CMD.maintBackupVerify(file)), 5 * MIN)).stdout)
        const size = Number(v.size?.out.trim())
        if (!(size > 0)) throw new Error(t('mm.backupEmpty'))
        if (v.gunzip_t?.rc !== 0) throw new Error(t('mm.gunzipFailed', { e: v.gunzip_t?.out.trim() }))
        if (!isDumpComplete(v.tail?.out ?? '')) throw new Error(t('mm.dumpIncomplete'))
        const remoteSha = v.sha?.out.trim() ?? ''
        const home = v.home?.out.trim()
        if (!home?.startsWith('/') || !/^[0-9a-f]{64}$/.test(remoteSha)) throw new Error(t('mm.shaUnreadable'))
        log(t('mm.onServer', { size, sha: remoteSha.slice(0, 16) }))

        log(t('mm.downloading', { p: localPath }))
        await sftpTransfer(c, 'get', `${home}/backups/${file}`, localPath)
        const localSize = statSync(localPath).size
        const localSha = await sha256File(localPath)
        if (localSize !== size || localSha !== remoteSha) {
          unlinkSync(localPath)
          throw new Error(t('mm.downloadMismatch', { a: localSize, b: size, sha: localSha === remoteSha ? t('mm.same') : t('mm.different') }))
        }
        log(t('mm.downloadOk'))

        const prune = await execOn(c, CMD.maintBackupPrune(), 60000)
        const removed = prune.stdout.split('\n').filter((l) => l.trim()).length
        log(removed ? t('mm.pruned', { n: removed }) : t('mm.nothingToPrune'))
        return { ok: true, summary: t('mm.backupSummary', { f: file, size, sha: remoteSha, p: localPath }) }
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
      await this.requireApt(serverId)
      const last = this.lastBackupAt(serverId)
      const noBackup = !last || Date.now() - last > BACKUP_KEEP_HOURS * 3600_000
      const ok = await confirm(t('mm.upgradeConfirm', { s: server.name }) + (noBackup ? `\n\n${t('mm.noBackupWarn')}` : ''), t('mm.upgradeOk'))
      if (!ok) return { ok: false, cancelled: true }
      const log = (l: string): void => this.line(serverId, 'upgrade', l)

      const sudo = parseSections((await this.monitor.execFor(serverId, buildScript(CMD.sudoCheck()), 20000)).stdout)
      if (sudo.sudo_apt?.rc !== 0) throw new Error(t('mm.noSudoApt'))

      const ts = jobStamp(new Date())
      const start = await this.monitor.execFor(serverId, CMD.maintUpgradeStart(ts), 30000)
      if (!start.stdout.includes('started')) throw new Error(t('mm.upgradeStartFailed', { e: (start.stdout + start.stderr).trim() }))
      log(t('mm.aptRunning', { ts }))

      const { rc, tail } = await this.followJob(serverId, 'upgrade', (offset) => CMD.maintUpgradePoll(ts, offset), 30 * MIN)
      if (rc == null) throw new Error(t('mm.upgradeTimeout'))
      if (rc !== 0) throw new Error(t('mm.aptExit', { c: rc }))

      const counts = tail.map((l) => /^(\d+) upgraded, (\d+) newly installed/.exec(l)).find(Boolean)
      log(t('mm.containerStatus'))
      const ps = await this.monitor.execFor(serverId, buildScript(CMD.maintStatus().filter((s) => s.name === 'ps')), 30000)
      for (const c of parsePsLines(parseSections(ps.stdout).ps?.out ?? '')) log(`${c.name}  ${c.status}`)
      this.monitor.refreshAll()
      return { ok: true, summary: counts ? t('mm.upgradeSummary', { a: counts[1], b: counts[2] }) : t('mm.upgradeDone') }
    }, (error) => ({ ok: false, error }))
  }

  /**
   * Sunucuda ayrık çalışan bir işin (jobStart) log'unu canlı akıtır ve bitmesini bekler.
   * Kısa SSH kopmaları işi etkilemez; 30 ardışık başarısız yoklamada vazgeçilir. rc null: süre doldu.
   */
  private async followJob(serverId: string, step: MaintStep, poll: (offset: number) => string, timeoutMs: number): Promise<{ rc: number | null; tail: string[] }> {
    const out = this.streamer(serverId, step)
    const deadline = Date.now() + timeoutMs
    let offset = 0
    let failures = 0
    let rc: number | null = null
    while (Date.now() < deadline) {
      await sleep(2000)
      try {
        const p = parseUpgradePoll((await this.monitor.execFor(serverId, poll(offset), 30000)).stdout)
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
        if (++failures >= 30) throw new Error(t('mm.unreachableRepeated', { e: (e as Error).message }))
      }
    }
    out.flush()
    return { rc, tail: out.tail }
  }

  // ------------------------------------------------------------ projeyi güncelle (deploy)

  /** docker compose pull && up -d: projenin compose etiketlerinden proje adı, dizin ve dosyalar okunur. */
  async deploy(serverId: string, projectId: string, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'deploy', async () => {
      this.requireActions()
      const server = this.server(serverId)
      const project = this.monitor.config.projectsOf(serverId).find((p) => p.id === projectId)
      if (!project) throw new Error(t('err.projectNotFound'))
      const spec = composeSpec(project, this.monitor.state(serverId)?.docker?.containers ?? [])
      const ok = await confirm(t('mm.deployConfirm', { s: server.name, p: project.name, c: spec.project }), t('mm.deployOk'))
      if (!ok) return { ok: false, cancelled: true }
      const log = (l: string): void => this.line(serverId, 'deploy', l)

      const ts = jobStamp(new Date())
      const start = await this.monitor.execFor(serverId, CMD.deployStart(ts, spec), 30000)
      if (!start.stdout.includes('started')) throw new Error(t('mm.upgradeStartFailed', { e: (start.stdout + start.stderr).trim() }))
      log(t('mm.deployRunning', { ts }))

      const { rc } = await this.followJob(serverId, 'deploy', (offset) => CMD.deployPoll(ts, offset), 20 * MIN)
      this.monitor.refreshServer(serverId)
      if (rc == null) throw new Error(t('mm.upgradeTimeout'))
      if (rc === 3) throw new Error(t('mm.noCompose'))
      if (rc !== 0) throw new Error(t('mm.deployExit', { c: rc }))
      return { ok: true, summary: t('mm.deployDone', { p: project.name }) }
    }, (error) => ({ ok: false, error }))
  }

  // ------------------------------------------------------------ reboot

  async reboot(serverId: string, confirmText: string, confirm: Confirm): Promise<PostcheckResult> {
    const fail = (error: string): PostcheckResult => ({ ok: false, error, containers: [], missing: [] })
    return this.run<PostcheckResult>(serverId, 'reboot', async () => {
      this.requireActions()
      if (confirmText !== 'REBOOT') throw new Error(t('err.rebootText'))
      const server = this.server(serverId)
      const log = (l: string): void => this.line(serverId, 'reboot', l)

      const pre = await this.statusRaw(serverId)
      if (!pre.ok) throw new Error(pre.error ?? t('mm.preRebootFailed'))
      const ctx: RebootCtx = { expectedKernel: pre.expectedKernel, containers: pre.containers.map((c) => c.name) }
      this.rebootCtx.set(serverId, ctx)
      const calls = this.monitor.state(serverId)?.asterisk?.activeCalls
      const ok = await confirm(
        `${t('mm.rebootConfirm', { s: server.name })}\n\n${t('maint.rebootWarning')}` +
          (server.asterisk ? ` ${t('maint.callsWarning')}` : '') +
          (calls != null ? `\n${t('maint.activeCalls', { n: calls })}` : '') +
          (pre.noRestart.length ? `\n\n${t('mm.noRestartConfirm')}\n• ${pre.noRestart.join('\n• ')}` : '') +
          (ctx.expectedKernel ? `\n\n${t('mm.expectedKernel', { k: ctx.expectedKernel })}` : ''),
        t('mm.rebootOk')
      )
      if (!ok) return { ok: false, cancelled: true, containers: [], missing: [] }

      log(t('mm.preReboot', { k: pre.kernel, n: ctx.containers.length }))
      if (pre.noRestart.length) log(t('mm.wontComeBack', { list: pre.noRestart.join(', ') }))
      const rebootAt = Date.now()
      try {
        const r = await this.session(serverId, (c) => execOn(c, CMD.maintReboot(), 20000))
        if (r.code !== 0 && r.code !== null) throw new RebootRejectedError(t('mm.rebootRejected', { e: r.stdout.trim() }))
      } catch (e) {
        // Bağlantının kopması beklenen durum; sadece komutun açıkça reddedilmesi hatadır
        if (e instanceof RebootRejectedError) throw e
      }
      log(t('mm.rebootSent'))

      await sleep(15000)
      let back = false
      while (Date.now() - rebootAt < 5 * MIN + 15000) {
        try {
          const r = await this.session(serverId, (c) => execOn(c, 'cat /proc/uptime', 10000))
          const up = Number(r.stdout.trim().split(/\s+/)[0])
          // Eski oturum henüz kapanmadıysa uptime büyük olur; yeni açılış uptime'ı reboot'tan bu yana geçen süreden küçüktür
          if (Number.isFinite(up) && up < (Date.now() - rebootAt) / 1000 + 30) {
            back = true
            log(t('mm.serverBack', { n: Math.round(up) }))
            break
          }
          log(t('mm.notDownYet'))
        } catch {
          log(t('mm.waiting', { n: Math.round((Date.now() - rebootAt) / 1000) }))
        }
        await sleep(10000)
      }
      if (!back) throw new Error(t('mm.notBack'))
      this.monitor.reconnect(serverId)

      log(t('mm.postcheckHeader'))
      const pc = await this.postcheckRaw(serverId, 'reboot', ctx)
      return { ...pc, summary: t('mm.rebootDone', { s: pc.summary ?? '' }) }
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
      log(t('mm.waitingContainers', { n: missing.length }))
      await sleep(5000)
    }
    log(t('mm.kernelLine', { k: res.kernel, x: res.expectedKernel ? (res.kernelOk ? ' ✓' : t('mm.kernelExpectedBad', { k: res.expectedKernel })) : '' }))
    log(t('mm.rebootReqLine', { v: res.rebootRequired ? t('mm.stillThere') : t('mm.none') }))
    for (const c of res.containers) log(`${c.ok ? '✓' : '✕'} ${c.name}  ${c.status}`)
    res.summary = t('mm.postSummary', { k: res.kernel, ok: res.containers.length - res.missing.length, n: res.containers.length })
    if (!res.ok) {
      const why = [
        res.kernelOk === false ? t('mm.whyKernel', { k: res.kernel, e: res.expectedKernel }) : '',
        res.rebootRequired ? t('mm.whyRebootReq') : '',
        res.missing.length ? t('mm.whyContainers', { list: res.missing.join(', ') }) : ''
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
      await this.requireApt(serverId)
      const kernel = (await this.monitor.execFor(serverId, 'uname -r', 15000)).stdout.trim()
      const ok = await confirm(t('mm.autoremoveConfirm', { s: server.name, k: kernel }), t('mm.autoremoveOk'))
      if (!ok) return { ok: false, cancelled: true }
      const out = this.streamer(serverId, 'autoremove')
      const r = await this.monitor.execFor(serverId, CMD.maintAutoremove(), 15 * MIN)
      out.push(r.stdout + r.stderr)
      out.flush()
      if (r.code !== 0) throw new Error(t('mm.autoremoveExit', { c: r.code }))
      const m = /(\d+) to remove/.exec(r.stdout)
      return { ok: true, summary: m ? t('mm.autoremoveSummary', { n: Number(m[1]) }) : t('mm.autoremoveDone') }
    }, (error) => ({ ok: false, error }))
  }

  // ------------------------------------------------------------ geri yükleme

  async restore(serverId: string, confirmText: string, localPath: string | null, confirm: Confirm): Promise<MaintResult> {
    return this.run<MaintResult>(serverId, 'restore', async () => {
      this.requireActions()
      if (confirmText !== 'RESTORE') throw new Error(t('err.restoreText'))
      if (!localPath) return { ok: false, cancelled: true }
      if (!localPath.endsWith('.sql.gz') || !existsSync(localPath)) throw new Error(t('mm.pickGz'))
      const server = this.server(serverId)
      const pg = await this.resolvePg(serverId)
      if (!pg) throw new Error(t('mm.noPgShort'))
      const ok = await confirm(t('mm.restoreConfirm', { s: server.name, c: pg.container, p: localPath }), t('mm.restoreOk'))
      if (!ok) return { ok: false, cancelled: true }
      const log = (l: string): void => this.line(serverId, 'restore', l)
      const file = safeBackupFile(`restore-${backupStamp(new Date(), true)}.sql.gz`)

      return this.session(serverId, async (c) => {
        const home = (await execOn(c, 'mkdir -p "$HOME/backups" && printf "%s" "$HOME"', 20000)).stdout.trim()
        if (!home.startsWith('/')) throw new Error(t('mm.homeUnreadable'))
        log(t('mm.uploading', { f: file }))
        await sftpTransfer(c, 'put', `${home}/backups/${file}`, localPath)
        const v = parseSections((await execOn(c, buildScript(CMD.maintBackupVerify(file)), 5 * MIN)).stdout)
        if (v.gunzip_t?.rc !== 0 || !isDumpComplete(v.tail?.out ?? '')) {
          await execOn(c, `rm -f "$HOME/backups/${file}"`, 20000)
          throw new Error(t('mm.badDump'))
        }
        log(t('mm.restoring'))
        const r = await execOn(c, CMD.maintRestore(file, pg.container, pg.user), 30 * MIN)
        const { errors, tail } = parseRestoreOutput(r.stdout + r.stderr)
        const out = this.streamer(serverId, 'restore')
        out.push(tail)
        out.flush()
        this.monitor.refreshAll()
        if (r.code !== 0) throw new Error(t('mm.restoreExit', { c: r.code }))
        // psql SQL hatalarında da 0 döner; hatalar ayrıca değerlendirilir
        const { expected, real } = summarizeRestoreErrors(errors)
        if (expected) log(t('mm.expectedWarnings', { n: expected }))
        if (real.length) {
          for (const e of real.slice(0, 20)) log(`✕ ${e}`)
          throw new Error(t('mm.restoreErrors', { n: `${real.length}${errors.length >= 200 ? '+' : ''}`, e: real[0] }))
        }
        return { ok: true, summary: `${localPath} → ${pg.container}${expected ? t('mm.restoreSummaryWarn', { n: expected }) : ''}` }
      })
    }, (error) => ({ ok: false, error }))
  }
}
