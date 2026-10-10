import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  AppSettings,
  HttpCheck,
  MaintenanceConfig,
  MaintStep,
  AppSnapshot,
  Issue,
  ProjectConfig,
  ServerConfig,
  ServerInput,
  ServerState,
  Severity
} from '@shared/types'
import type { ServerPatch } from '@shared/ipc'
import { t } from '@shared/i18n'
import { isMuted } from '@shared/mute'
import { KEYWORD_RE, SLOW_MS_RANGE, STATUS_SPEC_RE, validSlowMs } from '@shared/http'
import { COLLECTORS, tcpPing, type CollectorCtx, type ServerMemory } from './collectors'
import { Scheduler } from './scheduler'
import { SshConnection, type Credentials, type ExecResult, withTempConnection, execOn } from './ssh/connection'
import { SAFE_NAME, safeIp, safePort, safeUrlPath } from './ssh/commands'
import { ConfigStore, MAX_MUTE_MS } from './store/config'
import { SecretStore } from './store/secrets'
import { HistoryStore } from './store/history'
import { AlertEngine, type AlertTransition } from './alerts/engine'
import { evaluateServer, worst, type RawIssue } from './alerts/evaluate'

const HOST_RE = /^[A-Za-z0-9.\-:]{1,253}$/
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const RESUME_GRACE_MS = 90_000
/** Tüm sunucular erişilemezken internet kontrolünün en sık tekrarı. */
const NET_CHECK_MS = 15_000
/** Bu bilgisayarla ilgili (sunucuya bağlı olmayan) sorun anahtarlarının öneki. */
export const LOCAL_PREFIX = 'local:'

/** Herhangi bir genel adrese TCP bağlantısı kurulabiliyorsa internet var sayılır. */
export async function defaultInternetCheck(): Promise<boolean> {
  const targets: [string, number][] = [
    ['1.1.1.1', 443],
    ['8.8.8.8', 53],
    ['9.9.9.9', 443]
  ]
  const results = await Promise.allSettled(targets.map(([h, p]) => tcpPing(h, p, 4000)))
  return results.some((r) => r.status === 'fulfilled')
}


export function emptyState(serverId: string): ServerState {
  return { serverId, connection: 'idle', http: {}, ssl: {}, postgres: {}, errors: {} }
}

/** Bakım ayarını doğrular; boş alanlar atılır. */
export function sanitizeMaintenance(m: MaintenanceConfig | undefined): MaintenanceConfig | undefined {
  if (!m) return undefined
  const out: MaintenanceConfig = {}
  const c = m.pgContainer?.trim()
  const u = m.pgUser?.trim()
  if (c) {
    if (!SAFE_NAME.test(c)) throw new Error(t('err.badPgContainer', { v: c }))
    out.pgContainer = c
  }
  if (u) {
    if (!SAFE_NAME.test(u)) throw new Error(t('err.badPgUser', { v: u }))
    out.pgUser = u
  }
  return out.pgContainer || out.pgUser ? out : undefined
}

/** HTTP kontrolünün isteğe bağlı beklentileri: boşlar atılır, geçersizler hata fırlatır. */
export function sanitizeExpectations(c: Pick<HttpCheck, 'expectStatus' | 'keyword' | 'slowMs'>): Pick<HttpCheck, 'expectStatus' | 'keyword' | 'slowMs'> {
  const expectStatus = c.expectStatus?.trim() || undefined
  if (expectStatus && !STATUS_SPEC_RE.test(expectStatus)) throw new Error(t('err.badStatusSpec', { v: expectStatus }))
  const keyword = c.keyword || undefined
  if (keyword && !KEYWORD_RE.test(keyword)) throw new Error(t('err.badKeyword'))
  const slowMs = c.slowMs ? Number(c.slowMs) : undefined
  if (slowMs !== undefined && !validSlowMs(slowMs)) throw new Error(t('err.badSlowMs', { min: SLOW_MS_RANGE[0], max: SLOW_MS_RANGE[1] }))
  return { expectStatus, keyword, slowMs }
}

/** Proje yapılandırmasını doğrular ve temizler; geçersiz alanlar hata fırlatır. */
export function sanitizeProject(p: ProjectConfig, serverId: string): ProjectConfig {
  const names = (arr: string[]): string[] => [...new Set((arr ?? []).filter((n) => SAFE_NAME.test(n)))]
  if (!p.name?.trim()) throw new Error(t('err.projectNameEmpty'))
  const checks = (p.httpChecks ?? []).map((raw) => {
    const c = { ...raw, ...sanitizeExpectations(raw) }
    if (c.mode === 'public') {
      const u = new URL(c.url ?? '')
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t('err.badUrl', { v: c.url }))
      return { ...c, url: u.toString(), host: undefined, port: undefined, path: undefined }
    }
    return { ...c, host: safeIp(c.host ?? '127.0.0.1'), port: safePort(Number(c.port)), path: safeUrlPath(c.path), url: undefined }
  })
  if (p.postgres && (!SAFE_NAME.test(p.postgres.container) || !SAFE_NAME.test(p.postgres.user))) {
    throw new Error(t('err.badPg'))
  }
  return {
    ...p,
    id: p.id || randomUUID(),
    serverId,
    name: p.name.trim(),
    containers: names(p.containers),
    systemdUnits: names(p.systemdUnits),
    httpChecks: checks.map((c) => ({ ...c, id: c.id || randomUUID(), name: c.name?.trim() || c.url || `${c.host}:${c.port}` })),
    containerRoles: Object.fromEntries(Object.entries(p.containerRoles ?? {}).filter(([k]) => SAFE_NAME.test(k)))
  }
}

export class Monitor extends EventEmitter {
  readonly config: ConfigStore
  readonly secrets: SecretStore
  readonly history: HistoryStore
  private engine = new AlertEngine()
  private conns = new Map<string, SshConnection>()
  private states = new Map<string, ServerState>()
  private mems = new Map<string, ServerMemory>()
  private scheduler: Scheduler
  private emitTimer?: NodeJS.Timeout
  private evalTimer?: NodeJS.Timeout
  private purgeTimer?: NodeJS.Timeout
  private overall: Severity = 'unknown'
  /** Bu zamana kadar alarm değerlendirmesi yapılmaz (uyku/uyanma sonrası toparlanma). */
  private graceUntil = 0
  /** İnternet erişimi kontrolü (index.ts Electron'un net.isOnline'ını da ekler; testler sahte verir). */
  internetCheck: () => Promise<boolean> = defaultInternetCheck
  private offline = false
  private netCheck = { running: false, at: 0 }

  constructor(dataDir: string) {
    super()
    this.config = new ConfigStore(dataDir)
    this.secrets = new SecretStore(dataDir)
    this.history = new HistoryStore(`${dataDir}/history.sqlite`)
    this.scheduler = new Scheduler(
      COLLECTORS,
      (id) => this.ctx(id),
      (id, name) => {
        if (name === 'security') this.ensurePortBaseline(id)
        this.changed(true)
      }
    )
  }

  start(): void {
    for (const s of this.config.servers) this.initServer(s)
    this.evalTimer = setInterval(() => this.evaluate(), 5000)
    this.history.purge(this.config.settings.retentionHours)
    this.purgeTimer = setInterval(() => this.history.purge(this.config.settings.retentionHours), 3600_000)
  }

  stop(): void {
    clearInterval(this.evalTimer)
    clearInterval(this.purgeTimer)
    clearTimeout(this.emitTimer)
    this.scheduler.stopAll()
    for (const c of this.conns.values()) c.dispose()
    this.conns.clear()
    this.history.close()
  }

  // ------------------------------------------------------------------ durum

  private ctx(serverId: string): CollectorCtx | null {
    const server = this.config.server(serverId)
    const conn = this.conns.get(serverId)
    const state = this.states.get(serverId)
    const mem = this.mems.get(serverId)
    if (!server || !conn || !state || !mem) return null
    return { server, projects: this.config.projectsOf(serverId), conn, state, settings: this.config.settings, history: this.history, mem }
  }

  private initServer(s: ServerConfig): void {
    const state = emptyState(s.id)
    this.states.set(s.id, state)
    this.mems.set(s.id, { prevStat: null, prevNet: null, prevRestarts: new Map() })
    const conn = new SshConnection(
      () => this.config.server(s.id),
      () => this.credsFor(s.id)
    )
    conn.on('status', (st: ServerState['connection'], err?: string) => {
      state.connection = st
      state.connError = err
      if (st === 'ready') this.scheduler.runNow(s.id)
      if (st === 'error' || st === 'auth-failed' || st === 'hostkey-mismatch') this.scheduler.runNow(s.id, (c) => c.name === 'reach')
      this.changed(true)
    })
    this.conns.set(s.id, conn)
    if (s.enabled) conn.start()
    else state.connection = 'disabled'
    this.scheduler.startServer(s.id)
  }

  private teardownServer(id: string): void {
    this.scheduler.stopServer(id)
    this.conns.get(id)?.dispose()
    this.conns.delete(id)
    this.states.delete(id)
    this.mems.delete(id)
    this.engine.forget(`${id}:`)
  }

  /** Yeniden değerlendir + renderer'a gönder (300 ms ile birleştirilir). */
  changed(evaluate = false): void {
    if (evaluate) this.evaluate(false)
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit('snapshot', this.snapshot())
    }, 300)
  }

  private evaluate(emit = true): void {
    const now = Date.now()
    // Uykudan dönüşte ağ ve SSH bağlantıları yeniden kurulurken yanlış alarm üretme
    if (now < this.graceUntil) return
    const th = this.config.settings.thresholds
    this.updateOffline(now)
    let transitions: AlertTransition
    if (this.offline) {
      // Sorun bu bilgisayarın bağlantısında: sunucu alarmları ne açılır ne de "düzeldi" sayılır (dondurulur)
      const issue: RawIssue = { key: `${LOCAL_PREFIX}offline`, serverId: '', severity: 'warn', title: t('alert.offline'), detail: t('alert.offlineDetail') }
      transitions = this.engine.update([issue], now, th.debounceSec * 1000, (key) => key.startsWith(LOCAL_PREFIX))
    } else {
      const raw: RawIssue[] = []
      for (const s of this.config.servers) {
        raw.push(...evaluateServer(s, this.config.projectsOf(s.id), this.states.get(s.id), th, now))
      }
      transitions = this.engine.update(raw, now, th.debounceSec * 1000)
    }
    this.handleTransitions(transitions, now)
    const prev = this.overall
    this.overall = this.computeOverall()
    if (prev !== this.overall) this.emit('overall', this.overall)
    if (emit && (transitions.opened.length || transitions.resolved.length || transitions.escalated.length)) this.changed()
  }

  /**
   * Etkin sunucuların hepsine TCP ile ulaşılamıyorsa sorun büyük ihtimalle bu bilgisayarın internetindedir;
   * bunu genel adreslere bağlanarak doğrular. Sonuç bir sonraki değerlendirmede kullanılır.
   */
  private updateOffline(now: number): void {
    const enabled = this.config.servers.filter((s) => s.enabled)
    const allDown = enabled.length > 0 && enabled.every((s) => this.states.get(s.id)?.reach?.tcpOk === false)
    if (!allDown) {
      this.offline = false
      return
    }
    if (this.netCheck.running || now - this.netCheck.at < NET_CHECK_MS) return
    this.netCheck = { running: true, at: now }
    this.internetCheck().then(
      (online) => {
        this.netCheck.running = false
        if (this.offline === online) {
          this.offline = !online
          this.changed(true)
        }
      },
      () => {
        this.netCheck.running = false
      }
    )
  }

  get isOffline(): boolean {
    return this.offline
  }

  /** Olaylar her zaman geçmişe yazılır; sessize alınmış sorunlar için bildirim ('alert') yayınlanmaz. */
  private handleTransitions(t: AlertTransition, now: number): void {
    const mutes = this.config.activeMutes(now)
    const notify = (i: Issue, kind: 'open' | 'resolved'): void => {
      this.history.addEvent(i, kind, now)
      if (!isMuted(i.key, mutes, now)) this.emit('alert', i, kind)
    }
    for (const i of t.opened) notify(i, 'open')
    for (const i of t.escalated) notify(i, 'open')
    for (const i of t.resolved) notify(i, 'resolved')
  }

  /** Sorunu (tam anahtar) ya da sunucunun tümünü ("sunucuId:") belirli bir zamana kadar sessize alır. */
  mute(key: string, until: number): void {
    const now = Date.now()
    if (typeof key !== 'string' || key.length < 2 || key.length > 300) throw new Error(t('err.badMute'))
    if (!Number.isFinite(until) || until <= now) throw new Error(t('err.badMute'))
    this.config.setMute(key, Math.min(until, now + MAX_MUTE_MS))
    this.changed()
  }

  unmute(key: string): void {
    this.config.setMute(String(key), null)
    this.changed()
  }

  private computeOverall(): Severity {
    const enabled = this.config.servers.filter((s) => s.enabled)
    if (enabled.length === 0) return 'unknown'
    const issues = this.engine.activeIssues()
    const sevs: Severity[] = issues.map((i) => i.severity)
    for (const s of enabled) {
      const st = this.states.get(s.id)
      if (!st || st.connection !== 'ready' || !st.host) sevs.push('unknown')
    }
    const w = worst(sevs)
    // Hiç sorun yok ama bazı sunucular henüz bağlanmadıysa "unknown" yerine sorunları öne çıkar
    return w
  }

  issues(): Issue[] {
    return this.engine.activeIssues()
  }

  snapshot(): AppSnapshot {
    const states: Record<string, ServerState> = {}
    for (const [id, st] of this.states) states[id] = st
    return {
      servers: this.config.servers,
      projects: this.config.projects,
      settings: this.config.settings,
      states,
      issues: this.engine.activeIssues(),
      overall: this.overall,
      mutes: this.config.activeMutes()
    }
  }

  get overallSeverity(): Severity {
    return this.overall
  }

  refreshAll(): void {
    for (const s of this.config.servers) {
      const conn = this.conns.get(s.id)
      if (conn && !conn.isReady && s.enabled) conn.reconnectNow()
      this.scheduler.runNow(s.id)
    }
  }

  reconnect(id: string): void {
    this.conns.get(id)?.reconnectNow()
  }

  /** İlk güvenlik taramasında dinlenen portlar taban kabul edilir; sonradan açılan port alarm üretir. */
  private ensurePortBaseline(id: string): void {
    const server = this.config.server(id)
    const ports = this.states.get(id)?.security?.ports
    if (server && !server.portBaseline && ports?.length) this.config.upsertServer({ ...server, portBaseline: ports })
  }

  /** Şu an dinlenen portları yeni taban olarak kabul eder ("yeni port" alarmları kapanır). */
  acceptPorts(id: string): void {
    const server = this.config.server(id)
    const ports = this.states.get(id)?.security?.ports
    if (!server || !ports) throw new Error(t('err.serverNotFound'))
    this.config.upsertServer({ ...server, portBaseline: ports })
    this.changed(true)
  }

  /** Bir işlemden sonra sunucunun tüm toplayıcılarını hemen çalıştırır. */
  refreshServer(id: string): void {
    this.scheduler.runNow(id)
  }

  /**
   * Bilgisayar uykudan uyandı: eski TCP bağlantıları büyük ihtimalle ölü. Hepsini hemen yeniden kur,
   * erişim sayaçlarını sıfırla ve ağın toparlanması için kısa süre alarm değerlendirme.
   */
  onResume(graceMs = RESUME_GRACE_MS): void {
    this.graceUntil = Date.now() + graceMs
    for (const s of this.config.servers) {
      const st = this.states.get(s.id)
      if (st?.reach) st.reach.consecutiveFailures = 0
      if (!s.enabled) continue
      const conn = this.conns.get(s.id)
      // auth-failed / hostkey-mismatch kullanıcı müdahalesi bekler
      if (conn && conn.status !== 'auth-failed' && conn.status !== 'hostkey-mismatch') conn.reconnectNow()
      this.scheduler.runNow(s.id, (c) => !c.needsSsh)
    }
  }

  // ----------------------------------------------------------- yapılandırma

  /**
   * Bağlantı için kayıtlı kimlik bilgisi. Agent ile girişte sır gerekmez: sırsız içe aktarılan
   * agent sunucusunun kaydı hiç olmayabilir, bu durumda boş bilgi yeterlidir.
   */
  credsFor(serverId: string): Credentials | null {
    return this.secrets.get(serverId) ?? (this.config.server(serverId)?.authType === 'agent' ? {} : null)
  }

  /** Formdaki gizli alanları mevcut kayıtla birleştirerek kimlik bilgisini üretir. */
  resolveCreds(input: ServerInput): Credentials {
    // Agent ile girişte sır saklanmaz; imzayı işletim sistemindeki agent atar
    if (input.authType === 'agent') return {}
    const existing = input.id ? this.secrets.get(input.id) : null
    if (input.authType === 'password') {
      const password = input.password || existing?.password
      if (!password) throw new Error(t('err.passwordRequired'))
      return { password }
    }
    let privateKey = existing?.privateKey
    if (input.privateKeyPath) {
      const size = statSync(input.privateKeyPath).size
      if (size > 64 * 1024) throw new Error(t('err.keyTooLarge'))
      privateKey = readFileSync(input.privateKeyPath, 'utf8')
    }
    if (!privateKey) throw new Error(t('err.keyRequired'))
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) throw new Error(t('err.notAKey'))
    return { privateKey, passphrase: input.passphrase || existing?.passphrase || undefined }
  }

  validateInput(input: ServerInput): void {
    if (!input.name?.trim()) throw new Error(t('err.serverNameRequired'))
    if (!['key', 'password', 'agent'].includes(input.authType)) throw new Error(t('err.badAuthType'))
    if (!HOST_RE.test(input.host ?? '')) throw new Error(t('err.badHost'))
    safePort(Number(input.port))
    if (!USER_RE.test(input.username ?? '')) throw new Error(t('err.badUser'))
    for (const u of input.systemdUnits ?? []) if (!SAFE_NAME.test(u)) throw new Error(t('err.badUnit', { v: u }))
  }

  saveServer(input: ServerInput): ServerConfig {
    this.validateInput(input)
    if (!input.hostKeyFingerprint) throw new Error(t('err.confirmHostKey'))
    const creds = this.resolveCreds(input)
    const id = input.id ?? randomUUID()
    const prev = this.config.server(id)
    const server: ServerConfig = {
      id,
      name: input.name.trim(),
      host: input.host.trim(),
      port: Number(input.port),
      username: input.username.trim(),
      authType: input.authType,
      agent: input.authType === 'agent' ? (input.agent === 'pageant' ? 'pageant' : 'openssh') : undefined,
      keyFileName: input.authType === 'key' ? (input.privateKeyPath ? basename(input.privateKeyPath) : prev?.keyFileName) : undefined,
      hostKeyFingerprint: input.hostKeyFingerprint,
      systemdUnits: [...new Set(input.systemdUnits ?? [])],
      asterisk: !!input.asterisk,
      prometheus: !!input.prometheus,
      enabled: input.enabled !== false,
      maintenance: sanitizeMaintenance(input.maintenance),
      // Düzenlemede port tabanı korunur (aksi halde araya giren yeni port sessizce kabul edilirdi)
      portBaseline: prev?.portBaseline
    }
    this.secrets.set(id, creds)
    this.config.upsertServer(server)
    if (prev) this.teardownServer(id)
    this.initServer(server)
    this.changed(true)
    return server
  }

  patchServer(id: string, patch: ServerPatch): ServerConfig {
    const prev = this.config.server(id)
    if (!prev) throw new Error(t('err.serverNotFound'))
    const next: ServerConfig = { ...prev }
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error(t('err.serverNameRequired'))
      next.name = patch.name.trim()
    }
    if (patch.systemdUnits !== undefined) {
      for (const u of patch.systemdUnits) if (!SAFE_NAME.test(u)) throw new Error(t('err.badUnit', { v: u }))
      next.systemdUnits = [...new Set(patch.systemdUnits)]
    }
    if (patch.asterisk !== undefined) next.asterisk = !!patch.asterisk
    if (patch.prometheus !== undefined) next.prometheus = !!patch.prometheus
    if (patch.maintenance !== undefined) next.maintenance = sanitizeMaintenance(patch.maintenance)
    const enabledChanged = patch.enabled !== undefined && !!patch.enabled !== prev.enabled
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    this.config.upsertServer(next)
    if (enabledChanged) {
      this.teardownServer(id)
      this.initServer(next)
    } else {
      this.scheduler.runNow(id)
    }
    this.changed(true)
    return next
  }

  /**
   * Dışa aktarma dosyasından gelen sunucuyu doğrulayıp ekler. Host key parmak izi dosyadan gelir (TOFU onayı korunur);
   * kimlik bilgisi yoksa sunucu "kayıtlı kimlik bilgisi yok" durumunda bekler, kullanıcı Düzenle'den ekler.
   */
  addImportedServer(s: ServerConfig, projects: ProjectConfig[], creds: Credentials | null): void {
    this.validateInput({ ...s, password: undefined, privateKeyPath: undefined, passphrase: undefined })
    const server: ServerConfig = {
      id: s.id,
      name: s.name.trim(),
      host: s.host.trim(),
      port: Number(s.port),
      username: s.username.trim(),
      authType: s.authType,
      agent: s.authType === 'agent' ? (s.agent === 'pageant' ? 'pageant' : 'openssh') : undefined,
      keyFileName: s.authType === 'key' ? s.keyFileName : undefined,
      hostKeyFingerprint: typeof s.hostKeyFingerprint === 'string' && s.hostKeyFingerprint.startsWith('SHA256:') ? s.hostKeyFingerprint : undefined,
      systemdUnits: [...new Set(s.systemdUnits ?? [])],
      asterisk: !!s.asterisk,
      prometheus: !!s.prometheus,
      enabled: s.enabled !== false,
      maintenance: sanitizeMaintenance(s.maintenance),
      portBaseline: Array.isArray(s.portBaseline) ? s.portBaseline.filter((p) => typeof p === 'string' && p.length < 100) : undefined
    }
    const clean = projects.map((p) => sanitizeProject(p, server.id))
    if (creds) this.secrets.set(server.id, creds)
    this.config.upsertServer(server)
    this.config.replaceProjects(server.id, clean)
    this.initServer(server)
    this.changed(true)
  }

  removeServer(id: string): void {
    this.teardownServer(id)
    this.config.removeServer(id)
    this.secrets.remove(id)
    this.history.deleteServer(id)
    this.changed(true)
  }

  saveProjects(serverId: string, projects: ProjectConfig[]): void {
    if (!this.config.server(serverId)) throw new Error(t('err.serverNotFound'))
    const clean = projects.map((p) => sanitizeProject(p, serverId))
    this.config.replaceProjects(serverId, clean)
    const st = this.states.get(serverId)
    if (st) {
      // Silinen kontrollerin eski sonuçlarını temizle
      const ids = new Set(clean.flatMap((p) => p.httpChecks.map((c) => c.id)))
      for (const k of Object.keys(st.http)) if (!ids.has(k)) delete st.http[k]
      const pids = new Set(clean.map((p) => p.id))
      for (const k of Object.keys(st.postgres)) if (!pids.has(k)) delete st.postgres[k]
    }
    this.scheduler.runNow(serverId)
    this.changed(true)
  }

  removeProject(id: string): void {
    const p = this.config.projects.find((x) => x.id === id)
    this.config.removeProject(id)
    if (p) this.scheduler.runNow(p.serverId)
    this.changed(true)
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const s = this.config.updateSettings(patch)
    this.changed(true)
    return s
  }

  // ------------------------------------------------------------- yardımcılar

  state(id: string): ServerState | undefined {
    return this.states.get(id)
  }

  /** Süren bakım işini duruma yazar (null: bitti). Reboot sırasında erişim alarmları susturulur. */
  setMaintenance(id: string, step: MaintStep | null): void {
    const st = this.states.get(id)
    if (!st) return
    st.maintenance = step ? { step, since: Date.now() } : undefined
    this.changed(true)
  }

  connection(id: string): SshConnection | undefined {
    return this.conns.get(id)
  }

  /** Bağlıysa kalıcı bağlantıyı, değilse kayıtlı bilgilerle geçici bağlantıyı kullanır. */
  async execFor(serverId: string, cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    const server = this.config.server(serverId)
    if (!server) throw new Error(t('err.serverNotFound'))
    const conn = this.conns.get(serverId)
    if (conn?.isReady) return conn.exec(cmd, timeoutMs)
    const creds = this.credsFor(serverId)
    if (!creds) throw new Error(t('err.noCreds'))
    return withTempConnection(server, creds, server.hostKeyFingerprint, (c) => execOn(c, cmd, timeoutMs))
  }
}
