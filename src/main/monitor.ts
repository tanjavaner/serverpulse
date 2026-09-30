import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  AppSettings,
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
import { COLLECTORS, type CollectorCtx, type ServerMemory } from './collectors'
import { Scheduler } from './scheduler'
import { SshConnection, type Credentials, type ExecResult, withTempConnection, execOn } from './ssh/connection'
import { SAFE_NAME, safeIp, safePort, safeUrlPath } from './ssh/commands'
import { ConfigStore } from './store/config'
import { SecretStore } from './store/secrets'
import { HistoryStore } from './store/history'
import { AlertEngine, type AlertTransition } from './alerts/engine'
import { evaluateServer, worst, type RawIssue } from './alerts/evaluate'

const HOST_RE = /^[A-Za-z0-9.\-:]{1,253}$/
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

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
    if (!SAFE_NAME.test(c)) throw new Error(`Geçersiz PostgreSQL container adı: ${c}`)
    out.pgContainer = c
  }
  if (u) {
    if (!SAFE_NAME.test(u)) throw new Error(`Geçersiz PostgreSQL kullanıcı adı: ${u}`)
    out.pgUser = u
  }
  return out.pgContainer || out.pgUser ? out : undefined
}

/** Proje yapılandırmasını doğrular ve temizler; geçersiz alanlar hata fırlatır. */
export function sanitizeProject(p: ProjectConfig, serverId: string): ProjectConfig {
  const names = (arr: string[]): string[] => [...new Set((arr ?? []).filter((n) => SAFE_NAME.test(n)))]
  if (!p.name?.trim()) throw new Error('Proje adı boş olamaz')
  const checks = (p.httpChecks ?? []).map((c) => {
    if (c.mode === 'public') {
      const u = new URL(c.url ?? '')
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Geçersiz URL: ${c.url}`)
      return { ...c, url: u.toString(), host: undefined, port: undefined, path: undefined }
    }
    return { ...c, host: safeIp(c.host ?? '127.0.0.1'), port: safePort(Number(c.port)), path: safeUrlPath(c.path), url: undefined }
  })
  if (p.postgres && (!SAFE_NAME.test(p.postgres.container) || !SAFE_NAME.test(p.postgres.user))) {
    throw new Error('Geçersiz PostgreSQL container/kullanıcı adı')
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

  constructor(dataDir: string) {
    super()
    this.config = new ConfigStore(dataDir)
    this.secrets = new SecretStore(dataDir)
    this.history = new HistoryStore(`${dataDir}/history.sqlite`)
    this.scheduler = new Scheduler(COLLECTORS, (id) => this.ctx(id), () => this.changed(true))
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
    this.mems.set(s.id, { prevStat: null, prevRestarts: new Map() })
    const conn = new SshConnection(
      () => this.config.server(s.id),
      () => this.secrets.get(s.id)
    )
    conn.on('status', (st: ServerState['connection'], err?: string) => {
      state.connection = st
      state.connError = err
      if (st === 'ready') this.scheduler.runNow(s.id)
      if (st === 'error' || st === 'hostkey-mismatch') this.scheduler.runNow(s.id, (c) => c.name === 'reach')
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
    const th = this.config.settings.thresholds
    const raw: RawIssue[] = []
    for (const s of this.config.servers) {
      raw.push(...evaluateServer(s, this.config.projectsOf(s.id), this.states.get(s.id), th, now))
    }
    const t = this.engine.update(raw, now, th.debounceSec * 1000)
    this.handleTransitions(t, now)
    const prev = this.overall
    this.overall = this.computeOverall()
    if (prev !== this.overall) this.emit('overall', this.overall)
    if (emit && (t.opened.length || t.resolved.length || t.escalated.length)) this.changed()
  }

  private handleTransitions(t: AlertTransition, now: number): void {
    for (const i of t.opened) {
      this.history.addEvent(i, 'open', now)
      this.emit('alert', i, 'open')
    }
    for (const i of t.escalated) {
      this.history.addEvent(i, 'open', now)
      this.emit('alert', i, 'open')
    }
    for (const i of t.resolved) {
      this.history.addEvent(i, 'resolved', now)
      this.emit('alert', i, 'resolved')
    }
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
      overall: this.overall
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

  // ----------------------------------------------------------- yapılandırma

  /** Formdaki gizli alanları mevcut kayıtla birleştirerek kimlik bilgisini üretir. */
  resolveCreds(input: ServerInput): Credentials {
    const existing = input.id ? this.secrets.get(input.id) : null
    if (input.authType === 'password') {
      const password = input.password || existing?.password
      if (!password) throw new Error('Şifre gerekli')
      return { password }
    }
    let privateKey = existing?.privateKey
    if (input.privateKeyPath) {
      const size = statSync(input.privateKeyPath).size
      if (size > 64 * 1024) throw new Error('Anahtar dosyası beklenenden büyük')
      privateKey = readFileSync(input.privateKeyPath, 'utf8')
    }
    if (!privateKey) throw new Error('Özel anahtar dosyası seçilmeli')
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) throw new Error('Dosya bir özel anahtar gibi görünmüyor (PEM/OpenSSH biçimi bekleniyor)')
    return { privateKey, passphrase: input.passphrase || existing?.passphrase || undefined }
  }

  validateInput(input: ServerInput): void {
    if (!input.name?.trim()) throw new Error('Sunucu adı gerekli')
    if (!HOST_RE.test(input.host ?? '')) throw new Error('Geçersiz host/IP')
    safePort(Number(input.port))
    if (!USER_RE.test(input.username ?? '')) throw new Error('Geçersiz kullanıcı adı')
    for (const u of input.systemdUnits ?? []) if (!SAFE_NAME.test(u)) throw new Error(`Geçersiz unit adı: ${u}`)
  }

  saveServer(input: ServerInput): ServerConfig {
    this.validateInput(input)
    if (!input.hostKeyFingerprint) throw new Error('Kaydetmeden önce bağlantıyı test edip host key parmak izini onaylayın')
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
      keyFileName: input.authType === 'key' ? (input.privateKeyPath ? basename(input.privateKeyPath) : prev?.keyFileName) : undefined,
      hostKeyFingerprint: input.hostKeyFingerprint,
      systemdUnits: [...new Set(input.systemdUnits ?? [])],
      asterisk: !!input.asterisk,
      prometheus: !!input.prometheus,
      enabled: input.enabled !== false,
      maintenance: sanitizeMaintenance(input.maintenance)
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
    if (!prev) throw new Error('Sunucu bulunamadı')
    const next: ServerConfig = { ...prev }
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('Sunucu adı gerekli')
      next.name = patch.name.trim()
    }
    if (patch.systemdUnits !== undefined) {
      for (const u of patch.systemdUnits) if (!SAFE_NAME.test(u)) throw new Error(`Geçersiz unit adı: ${u}`)
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

  removeServer(id: string): void {
    this.teardownServer(id)
    this.config.removeServer(id)
    this.secrets.remove(id)
    this.history.deleteServer(id)
    this.changed(true)
  }

  saveProjects(serverId: string, projects: ProjectConfig[]): void {
    if (!this.config.server(serverId)) throw new Error('Sunucu bulunamadı')
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
    if (!server) throw new Error('Sunucu bulunamadı')
    const conn = this.conns.get(serverId)
    if (conn?.isReady) return conn.exec(cmd, timeoutMs)
    const creds = this.secrets.get(serverId)
    if (!creds) throw new Error('Kayıtlı kimlik bilgisi yok')
    return withTempConnection(server, creds, server.hostKeyFingerprint, (c) => execOn(c, cmd, timeoutMs))
  }
}
