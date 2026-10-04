import type {
  ActionResult,
  AlertEvent,
  AppSettings,
  AppSnapshot,
  ContainerSample,
  DiscoveryResult,
  HostKeyProbe,
  HostSample,
  HttpSample,
  LogResult,
  BackupInfo,
  MaintEvent,
  MaintResult,
  MaintStatus,
  NotifyTestResult,
  PostcheckResult,
  RemoteNotifyInput,
  ProjectConfig,
  PromPreset,
  PromResult,
  ServerConfig,
  ServerInput,
  TestResult,
  UpdateStatus
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
  'projects:save': (serverId: string, projects: ProjectConfig[]) => void
  'project:remove': (id: string) => void
  'settings:save': (patch: Partial<AppSettings>) => AppSettings
  /** Harici bildirim kanalları (token/URL safeStorage'a yazılır). */
  'notify:save': (input: RemoteNotifyInput) => AppSettings
  'notify:test': () => NotifyTestResult[]
  'logs:get': (serverId: string, kind: 'container' | 'unit', name: string) => LogResult
  'history:host': (serverId: string, sinceMs: number) => HostSample[]
  'history:containers': (serverId: string, sinceMs: number) => ContainerSample[]
  'history:http': (checkIds: string[], sinceMs: number) => HttpSample[]
  'events:list': (limit: number) => AlertEvent[]
  'prometheus:query': (serverId: string, preset: PromPreset, hours: number) => PromResult
  'action:restartContainer': (serverId: string, name: string) => ActionResult
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
  'maint:openBackupDir': (serverId: string) => void
  'app:refresh': () => void
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

export interface RendererApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<InvokeApi[K]>
  ): Promise<ReturnType<InvokeApi[K]>>
  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  onNavigate(cb: (serverId: string) => void): () => void
  onMaint(cb: (e: MaintEvent) => void): () => void
  onUpdate(cb: (s: UpdateStatus) => void): () => void
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
  'projects:save',
  'project:remove',
  'settings:save',
  'notify:save',
  'notify:test',
  'logs:get',
  'history:host',
  'history:containers',
  'history:http',
  'events:list',
  'prometheus:query',
  'action:restartContainer',
  'maint:status',
  'maint:backup',
  'maint:upgrade',
  'maint:reboot',
  'maint:postcheck',
  'maint:autoremove',
  'maint:restore',
  'maint:listBackups',
  'maint:openBackupDir',
  'app:refresh',
  'update:status',
  'update:check',
  'update:install',
  'window:openDashboard',
  'window:hideWidget',
  'window:widgetHeight'
]
