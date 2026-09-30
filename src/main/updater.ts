import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

const FIRST_CHECK_MS = 15_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface UpdaterHooks {
  onStatus: (s: UpdateStatus) => void
  /** İndirme bitti; sürüm başına bir kez çağrılır. */
  onReady: (version: string) => void
  /** quitAndInstall'dan hemen önce: pencere kapanışları uygulamayı tray'de tutmasın. */
  beforeInstall: () => void
}

/**
 * GitHub Releases'tan otomatik güncelleme (electron-updater).
 * Arka planda indirir; kurulum kullanıcı onayıyla ya da uygulama kapanırken yapılır.
 * Geliştirme modunda (paketsiz) devre dışıdır.
 */
export class Updater {
  private status: UpdateStatus
  private timer: NodeJS.Timeout | null = null
  private notifiedVersion: string | null = null

  constructor(private hooks: UpdaterHooks) {
    this.status = { state: app.isPackaged ? 'idle' : 'disabled', current: app.getVersion() }
    if (!app.isPackaged) return

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = console

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'uptodate' }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => {
      this.set({ state: 'ready', version: i.version, percent: 100 })
      if (this.notifiedVersion !== i.version) {
        this.notifiedVersion = i.version
        this.hooks.onReady(i.version)
      }
    })
    autoUpdater.on('error', (e) => {
      // İndirilmiş güncelleme varken sonraki denetim hatası "hazır" durumunu ezmesin
      if (this.status.state !== 'ready') this.set({ state: 'error', error: e?.message ?? String(e) })
    })
  }

  start(): void {
    if (!app.isPackaged) return
    setTimeout(() => this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  check(): void {
    if (!app.isPackaged || this.status.state === 'ready' || this.status.state === 'downloading') return
    autoUpdater.checkForUpdates().catch(() => {
      // 'error' olayı zaten durumu güncelliyor
    })
  }

  install(): void {
    if (this.status.state !== 'ready') return
    this.hooks.beforeInstall()
    // isSilent=true: kurulum sihirbazı tekrar sorulmasın; isForceRunAfter=true: kurulumdan sonra yeniden aç
    autoUpdater.quitAndInstall(true, true)
  }

  private set(patch: Partial<UpdateStatus>): void {
    const next: UpdateStatus = { ...this.status, ...patch }
    if (patch.state && patch.state !== 'error') delete next.error
    this.status = next
    this.hooks.onStatus(next)
  }
}
