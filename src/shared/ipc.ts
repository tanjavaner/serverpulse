import type {
  ActionResult,
  ContainerAction,
  AlertEvent,
  AppSettings,
  AppSnapshot,
  ContainerSample,
  DiscoveryResult,
  ExportResult,
  ImportInspect,
  ImportResult,
  HostKeyProbe,
  HostSample,
  HttpSample,
  LogOptions,
  LogResult,
  BackupInfo,
  MaintEvent,
  MaintResult,
  MaintStatus,
  NotifyTestResult,
  ProcessResult,
  PostcheckResult,
  RemoteNotifyInput,
  ProjectConfig,
  PromPreset,
  PublicKeyResult,
  SshConfigHost,
  PromResult,
  ServerConfig,
  ServerInput,
  TermEvent,
  TestResult,
  UpdateStatus,
  Uptime
} from './types'

/**
 * Renderer'ın çağırabildiği tüm main process fonksiyonları (ipcRenderer.invoke).
 * Kanal adı = anahtar. Preload ve main tarafı bu tipten türetilir.
 */
export interface InvokeApi {
  'snapshot:get': () => AppSnapshot
  'server:save': (input: ServerInput) => ServerConfig
  'server:remove': (id: string) => void
  /** Gizli olmayan alanları bağlantıyı yeniden kurmadan günceller. */
  'server:update': (id: string, patch: ServerPatch) => ServerConfig
  'server:probeHostKey': (host: string, port: number) => HostKeyProbe
  'server:test': (input: ServerInput) => TestResult
  'server:discover': (id: string) => DiscoveryResult
  'server:pickKeyFile': () => string | null
  'server:reconnect': (id: string) => void
  /** Hazırlık betiği için: seçilen ya da kayıtlı özel anahtarın public satırı. */
  'server:publicKey': (input: { privateKeyPath?: string; serverId?: string; passphrase?: string }) => PublicKeyResult
  /** ~/.ssh/config'teki somut Host blokları. */
  'server:sshConfigHosts': () => SshConfigHost[]
  'projects:save': (serverId: string, projects: ProjectConfig[]) => void
  'project:remove': (id: string) => void
  'settings:save': (patch: Partial<AppSettings>) => AppSettings
  /** Harici bildirim kanalları (token/URL safeStorage'a yazılır). */
  'notify:save': (input: RemoteNotifyInput) => AppSettings
  'notify:test': () => NotifyTestResult[]
  'logs:get': (serverId: string, kind: 'container' | 'unit', name: string, opts?: LogOptions) => LogResult
  /** Görüntülenen log metnini kaydet diyaloğuyla dosyaya yazar. */
  'logs:save': (name: string, text: string) => ExportResult
  'history:host': (serverId: string, sinceMs: number) => HostSample[]
  'history:containers': (serverId: string, sinceMs: number) => ContainerSample[]
  'history:http': (checkIds: string[], sinceMs: number) => HttpSample[]
  /** 7/30 gün: 5 dakikalık özetler. */
  'history:hostRollup': (serverId: string, sinceMs: number) => HostSample[]
  'history:uptime': (checkIds: string[]) => Record<string, Uptime>
  'host:processes': (serverId: string) => ProcessResult
  /** Şu an dinlenen portları taban kabul eder. */
  'security:acceptPorts': (serverId: string) => void
  'events:list': (limit: number) => AlertEvent[]
  /** key: sorun anahtarı ya da tüm sunucu için "sunucuId:"; until: bitiş zamanı (ms). */
  'alerts:mute': (key: string, until: number) => void
  'alerts:unmute': (key: string) => void
  'prometheus:query': (serverId: string, preset: PromPreset, hours: number) => PromResult
  'action:container': (serverId: string, name: string, action: ContainerAction) => ActionResult
  /** safe: dangling image + build önbelleği; images: kullanılmayan tüm image'lar. Volume'lara dokunulmaz. */
  'action:prune': (serverId: string, mode: 'safe' | 'images') => ActionResult
  /** Bakım: salt okunur durum kontrolü (onaysız). */
  'maint:status': (serverId: string) => MaintStatus
  'maint:backup': (serverId: string) => MaintResult
  'maint:upgrade': (serverId: string) => MaintResult
  /** confirmText: kullanıcının UI'da yazdığı "REBOOT". */
  'maint:reboot': (serverId: string, confirmText: string) => PostcheckResult
  'maint:postcheck': (serverId: string) => PostcheckResult
  'maint:autoremove': (serverId: string) => MaintResult
  'maint:restore': (serverId: string, confirmText: string) => MaintResult
  'maint:listBackups': (serverId: string) => BackupInfo[]
  /** docker compose pull && up -d (projenin compose etiketlerinden). */
  'maint:deploy': (serverId: string, projectId: string) => MaintResult
  'maint:openBackupDir': (serverId: string) => void
  'app:refresh': () => void
  'app:copy': (text: string) => void
  /** Etkileşimli SSH terminali; id'yi renderer üretir (UUID) ki ilk çıktı kaçmasın. */
  'term:open': (serverId: string, id: string, cols: number, rows: number) => ActionResult
  'term:write': (id: string, data: string) => void
  'term:resize': (id: string, cols: number, rows: number) => void
  'term:close': (id: string) => void
  /** Yapılandırmayı dosyaya yazar (kaydet diyaloğu main'de). Sırlar yalnızca parolayla şifrelenerek eklenir. */
  'config:export': (opts: { includeSecrets: boolean; password?: string }) => ExportResult
  /** İçe aktarılacak dosyayı seçtirir ve özetini döner. */
  'config:inspectImport': () => ImportInspect
  'config:import': (path: string, opts: { password?: string; settings: boolean }) => ImportResult
  'update:status': () => UpdateStatus
  'update:check': () => void
  /** İndirilmiş güncellemeyi kurmak için uygulamayı yeniden başlatır. */
  'update:install': () => void
  'window:openDashboard': (serverId?: string) => void
  'window:hideWidget': () => void
  'window:widgetHeight': (height: number) => void
}

export type ServerPatch = Partial<Pick<ServerConfig, 'name' | 'systemdUnits' | 'asterisk' | 'prometheus' | 'enabled' | 'maintenance'>>

export type InvokeChannel = keyof InvokeApi

/** Main → renderer olayları. */
export const EVT_SNAPSHOT = 'evt:snapshot'
export const EVT_NAVIGATE = 'evt:navigate'
/** Bakım işlerinin canlı çıktısı (MaintEvent). */
export const EVT_MAINT = 'evt:maint'
/** Otomatik güncelleme durumu (UpdateStatus). */
export const EVT_UPDATE = 'evt:update'
/** Terminal çıktısı (TermEvent); yalnızca oturumu açan pencereye gönderilir. */
export const EVT_TERM = 'evt:term'

export interface RendererApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<InvokeApi[K]>
  ): Promise<ReturnType<InvokeApi[K]>>
  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  onNavigate(cb: (serverId: string) => void): () => void
  onMaint(cb: (e: MaintEvent) => void): () => void
  onUpdate(cb: (s: UpdateStatus) => void): () => void
  onTerm(cb: (e: TermEvent) => void): () => void
  platform: string
}

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'snapshot:get',
  'server:save',
  'server:remove',
  'server:update',
  'server:probeHostKey',
  'server:test',
  'server:discover',
  'server:pickKeyFile',
  'server:reconnect',
  'server:publicKey',
  'server:sshConfigHosts',
  'projects:save',
  'project:remove',
  'settings:save',
  'notify:save',
  'notify:test',
  'logs:get',
  'logs:save',
  'history:host',
  'history:containers',
  'history:http',
  'history:hostRollup',
  'history:uptime',
  'host:processes',
  'security:acceptPorts',
  'events:list',
  'alerts:mute',
  'alerts:unmute',
  'prometheus:query',
  'action:container',
  'action:prune',
  'maint:status',
  'maint:backup',
  'maint:upgrade',
  'maint:reboot',
  'maint:postcheck',
  'maint:autoremove',
  'maint:restore',
  'maint:listBackups',
  'maint:deploy',
  'maint:openBackupDir',
  'app:refresh',
  'app:copy',
  'term:open',
  'term:write',
  'term:resize',
  'term:close',
  'config:export',
  'config:inspectImport',
  'config:import',
  'update:status',
  'update:check',
  'update:install',
  'window:openDashboard',
  'window:hideWidget',
  'window:widgetHeight'
]
