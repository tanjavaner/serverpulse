// Main, preload ve renderer arasında paylaşılan tipler.

export type Severity = 'ok' | 'warn' | 'crit' | 'unknown'
export type IssueSeverity = 'warn' | 'crit'
export type AuthType = 'password' | 'key'
export type ComponentRole = 'backend' | 'frontend' | 'db' | 'asterisk' | 'monitoring' | 'other'

// ---------------------------------------------------------------------------
// Yapılandırma
// ---------------------------------------------------------------------------

export interface ServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** Sadece gösterim amaçlı: seçilen anahtar dosyasının adı. İçerik şifreli saklanır. */
  keyFileName?: string
  /** TOFU ile onaylanmış host key parmak izi (SHA256:...). */
  hostKeyFingerprint?: string
  /** Sunucu seviyesinde izlenecek systemd unit'leri. */
  systemdUnits: string[]
  /** Asterisk CLI okumaları (asterisk -rx) denensin mi. */
  asterisk: boolean
  /** 127.0.0.1:9090 Prometheus'a SSH tüneli ile uzun geçmiş grafikleri. */
  prometheus: boolean
  enabled: boolean
  /** Bakım (yedek/geri yükleme) ayarları. Boş alanlar projelerin PostgreSQL ayarından / otomatik tespitten gelir. */
  maintenance?: MaintenanceConfig
}

export interface MaintenanceConfig {
  pgContainer?: string
  pgUser?: string
}

/** Sunucu formundan gelen veri. Gizli alanlar boş bırakılırsa mevcut sır korunur. */
export interface ServerInput extends Omit<ServerConfig, 'id'> {
  id?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface HttpCheck {
  id: string
  name: string
  role: ComponentRole
  /** public: PC'den HTTPS isteği. local: SSH üzerinden sunucuda curl. */
  mode: 'public' | 'local'
  /** public mod: tam URL (https://...) */
  url?: string
  /** local mod: bağlanılacak IP (127.0.0.1 ya da container'ın bağlı olduğu IP) */
  host?: string
  port?: number
  path?: string
}

export interface PostgresCheck {
  container: string
  user: string
}

export interface ProjectConfig {
  id: string
  serverId: string
  name: string
  workingDir?: string
  containers: string[]
  containerRoles: Record<string, ComponentRole>
  systemdUnits: string[]
  httpChecks: HttpCheck[]
  postgres?: PostgresCheck
  asterisk: boolean
}

export interface Intervals {
  fastSec: number
  mediumSec: number
  slowSec: number
  sslHours: number
}

export interface Thresholds {
  diskPct: number
  ramPct: number
  ramDurationSec: number
  sslDays: number
  httpTimeoutSec: number
  unreachableAttempts: number
  debounceSec: number
}

/** Harici bildirim kanalları. Token/URL burada tutulmaz (safeStorage); yalnızca "kayıtlı mı" bilgisi. */
export interface RemoteNotifySettings {
  telegram: { enabled: boolean; chatId: string; hasToken: boolean }
  webhook: { enabled: boolean; hasUrl: boolean }
}

export interface RemoteNotifyInput {
  telegram: { enabled: boolean; chatId: string; /** Boş/undefined: mevcut token korunur. */ token?: string; clearToken?: boolean }
  webhook: { enabled: boolean; /** Boş/undefined: mevcut URL korunur. */ url?: string; clearUrl?: boolean }
}

export interface NotifyTestResult {
  channel: 'telegram' | 'webhook'
  ok: boolean
  error?: string
}

export interface AppSettings {
  intervals: Intervals
  thresholds: Thresholds
  notifications: boolean
  remoteNotify: RemoteNotifySettings
  openAtLogin: boolean
  widgetAlwaysOnTop: boolean
  widgetShowOnStart: boolean
  theme: 'system' | 'light' | 'dark'
  retentionHours: number
  allowActions: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  intervals: { fastSec: 5, mediumSec: 30, slowSec: 300, sslHours: 6 },
  thresholds: {
    diskPct: 85,
    ramPct: 90,
    ramDurationSec: 300,
    sslDays: 14,
    httpTimeoutSec: 10,
    unreachableAttempts: 2,
    debounceSec: 10
  },
  notifications: true,
  remoteNotify: {
    telegram: { enabled: false, chatId: '', hasToken: false },
    webhook: { enabled: false, hasUrl: false }
  },
  openAtLogin: false,
  widgetAlwaysOnTop: false,
  widgetShowOnStart: true,
  theme: 'system',
  retentionHours: 72,
  allowActions: false
}

// ---------------------------------------------------------------------------
// Toplanan durum
// ---------------------------------------------------------------------------

export type ConnStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'hostkey-mismatch' | 'disabled'

export interface DiskInfo {
  fs: string
  mount: string
  size: number
  used: number
  avail: number
  pct: number
}

export interface HostMetrics {
  ts: number
  cpuPct: number | null
  cores: number | null
  load: [number, number, number] | null
  memTotal: number | null
  memUsed: number | null
  memPct: number | null
  swapTotal: number | null
  swapUsed: number | null
  uptimeSec: number | null
  disks: DiskInfo[]
  /** RAM eşiğin üstüne ilk çıktığı an; eşik altındaysa null. */
  memHighSince: number | null
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  restartCount: number | null
  lastRestartIncreaseAt: number | null
  composeProject?: string
  workingDir?: string
  ports: string
  cpuPct: number | null
  memBytes: number | null
  memPct: number | null
}

export interface DockerState {
  ts: number
  available: boolean
  error?: string
  containers: ContainerInfo[]
}

export interface DockerDfRow {
  type: string
  total: number
  active: number
  size: string
  reclaimable: string
}

export interface DockerMeta {
  ts: number
  df: DockerDfRow[]
  error?: string
}

export interface SystemdUnitState {
  name: string
  state: string
}

export interface SystemdState {
  ts: number
  units: SystemdUnitState[]
  failed: string[]
  error?: string
}

export interface Reachability {
  ts: number
  tcpOk: boolean
  tcpMs: number | null
  sshOk: boolean
  sshMs: number | null
  consecutiveFailures: number
  error?: string
}

export interface HttpResult {
  checkId: string
  ts: number
  ok: boolean
  status: number | null
  ms: number | null
  error?: string
}

export interface SslResult {
  host: string
  ts: number
  daysLeft: number | null
  validTo?: string
  authorized: boolean
  error?: string
}

export interface PostgresState {
  ts: number
  ready: boolean | null
  connections: number | null
  databases: { name: string; size: number }[]
  error?: string
}

export interface AsteriskState {
  ts: number
  /** full: CLI okunabildi. limited: yetki yok, sadece systemd durumu biliniyor. */
  mode: 'full' | 'limited'
  activeChannels: number | null
  activeCalls: number | null
  callsProcessed: number | null
  registrations: { name: string; status: string }[]
  endpoints: { name: string; state: string }[]
  error?: string
}

export interface ServerState {
  serverId: string
  connection: ConnStatus
  connError?: string
  reach?: Reachability
  host?: HostMetrics
  docker?: DockerState
  dockerMeta?: DockerMeta
  systemd?: SystemdState
  http: Record<string, HttpResult>
  ssl: Record<string, SslResult>
  postgres: Record<string, PostgresState>
  asterisk?: AsteriskState
  /** Süren bakım işi (reboot sırasında erişim alarmları susturulur). */
  maintenance?: { step: MaintStep; since: number }
  /** Collector adı → son hata mesajı (başarılı çalışmada silinir). */
  errors: Record<string, string>
}

export interface Issue {
  key: string
  serverId: string
  projectId?: string
  severity: IssueSeverity
  title: string
  detail?: string
  since: number
}

export interface AppSnapshot {
  servers: ServerConfig[]
  projects: ProjectConfig[]
  settings: AppSettings
  states: Record<string, ServerState>
  issues: Issue[]
  overall: Severity
}

// ---------------------------------------------------------------------------
// İstek/yanıt tipleri
// ---------------------------------------------------------------------------

export interface HostKeyProbe {
  ok: boolean
  fingerprint?: string
  algorithm?: string
  error?: string
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  uname?: string
  id?: string
  dockerAccess: boolean
  dockerVersion?: string
  asteriskAccess: 'ok' | 'no-sudo' | 'not-installed' | 'unknown'
  warnings: string[]
  error?: string
}

export interface DiscoveryResult {
  ok: boolean
  error?: string
  proposals: ProjectConfig[]
  runningUnits: string[]
  suggestedUnits: string[]
  containers: { name: string; image: string; composeProject?: string; state: string }[]
  domains: string[]
}

export interface LogResult {
  ok: boolean
  lines: string
  error?: string
}

export interface HostSample {
  ts: number
  cpu: number | null
  mem: number | null
  disk: number | null
  load1: number | null
}

export interface ContainerSample {
  ts: number
  name: string
  cpu: number | null
  mem: number | null
}

export interface HttpSample {
  ts: number
  checkId: string
  status: number | null
  ms: number | null
}

export interface AlertEvent {
  id: number
  ts: number
  serverId: string
  projectId: string | null
  key: string
  severity: IssueSeverity
  kind: 'open' | 'resolved'
  title: string
  detail: string | null
}

export type PromPreset = 'cpu' | 'mem' | 'disk' | 'net'

export interface PromSeries {
  label: string
  points: { ts: number; value: number }[]
}

export interface PromResult {
  ok: boolean
  series: PromSeries[]
  error?: string
}

export interface ActionResult {
  ok: boolean
  cancelled?: boolean
  output?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Bakım
// ---------------------------------------------------------------------------

export type MaintStep = 'status' | 'backup' | 'upgrade' | 'reboot' | 'postcheck' | 'autoremove' | 'restore'

export interface UpgradablePkg {
  name: string
  version: string
  security: boolean
}

export interface MaintStatus {
  ok: boolean
  error?: string
  kernel?: string
  rebootRequired: boolean
  /** /var/run/reboot-required.pkgs içeriği. */
  rebootPkgs: string[]
  /** reboot-required.pkgs içindeki linux-image sürümü (ör. 6.8.0-142-generic). */
  expectedKernel?: string
  upgradable: UpgradablePkg[]
  uptime?: string
  diskRoot?: string
  containers: { name: string; status: string; image: string }[]
  /** Restart politikası "no" olan çalışan container'lar: reboot sonrası geri gelmezler. */
  noRestart: string[]
  pg?: { container: string; user: string }
  /** Son başarılı yedeğin zamanı (maintenance.log'dan). */
  lastBackupAt?: number
}

export interface MaintResult {
  ok: boolean
  cancelled?: boolean
  error?: string
  /** Kısa özet (log dosyasına da yazılır). */
  summary?: string
}

export interface BackupInfo {
  file: string
  size: number
  mtime: number
}

export interface PostcheckResult extends MaintResult {
  kernel?: string
  expectedKernel?: string
  kernelOk?: boolean
  rebootRequired?: boolean
  containers: { name: string; status: string; ok: boolean }[]
  missing: string[]
}

export interface MaintEvent {
  serverId: string
  step: MaintStep
  line?: string
  done?: boolean
  ok?: boolean
}

/** Otomatik güncelleme durumu (electron-updater). */
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** Çalışan sürüm. */
  current: string
  /** Bulunan/indirilen sürüm. */
  version?: string
  percent?: number
  error?: string
}
