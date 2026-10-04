import { Notification, app } from 'electron'
import { EVT_MAINT, EVT_SNAPSHOT, EVT_UPDATE } from '@shared/ipc'
import type { AppSnapshot, Issue, MaintEvent, UpdateStatus } from '@shared/types'
import { Monitor } from './monitor'
import { Maintenance } from './maintenance'
import { Updater } from './updater'
import { RemoteNotifier } from './notify'
import { registerIpc } from './ipc'
import { AppTray } from './tray'
import { allWindows, createWidget, getWidget, openDashboard, setWidgetHeight, setWidgetOnTop, toggleWidget } from './windows'

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let monitor: Monitor
  let tray: AppTray | null = null
  let quitting = false

  app.setAppUserModelId('com.yukselyazilim.serverpulse')

  app.on('second-instance', () => openDashboard())

  const applySettings = (): void => {
    const s = monitor.config.settings
    setWidgetOnTop(s.widgetAlwaysOnTop)
    // Geliştirme modunda electron.exe'yi başlangıca eklememek için sadece paketli sürümde uygula
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin })
  }

  const notify = (issue: Issue, kind: 'open' | 'resolved'): void => {
    if (!monitor.config.settings.notifications || !Notification.isSupported()) return
    const server = monitor.config.server(issue.serverId)
    const n = new Notification({
      title: kind === 'open' ? `${issue.severity === 'crit' ? '🔴' : '🟠'} ${issue.title}` : `✅ Düzeldi: ${issue.title}`,
      body: [server?.name, issue.detail].filter(Boolean).join(' · '),
      silent: kind === 'resolved'
    })
    n.on('click', () => openDashboard(issue.serverId))
    n.show()
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide()

    monitor = new Monitor(app.getPath('userData'))

    const maint = new Maintenance(monitor, app.getPath('userData'), (e: MaintEvent) => {
      for (const w of allWindows()) w.webContents.send(EVT_MAINT, e)
    })

    const updater = new Updater({
      onStatus: (s: UpdateStatus) => {
        for (const w of allWindows()) w.webContents.send(EVT_UPDATE, s)
      },
      onReady: (version) => {
        tray?.setUpdateReady(version)
        if (!Notification.isSupported()) return
        const n = new Notification({
          title: `ServerPulse v${version} hazır`,
          body: 'Yeniden başlatıp güncellemek için tıklayın. (Kapatınca da otomatik kurulur.)'
        })
        n.on('click', () => updater.install())
        n.show()
      },
      beforeInstall: () => {
        quitting = true
      }
    })

    const remote = new RemoteNotifier(monitor)

    registerIpc(monitor, maint, updater, remote, {
      openDashboard: (id) => void openDashboard(id),
      hideWidget: () => getWidget()?.hide(),
      setWidgetHeight,
      applySettings
    })

    monitor.on('snapshot', (s: AppSnapshot) => {
      for (const w of allWindows()) w.webContents.send(EVT_SNAPSHOT, s)
      tray?.setSeverity(s.overall, s.issues.length)
    })
    monitor.on('alert', notify)
    monitor.on('alert', (issue: Issue, kind: 'open' | 'resolved') => remote.send(issue, kind))

    tray = new AppTray({
      toggleWidget: () => {
        if (!getWidget()) createWidget(monitor.config.settings.widgetAlwaysOnTop, true)
        else toggleWidget()
      },
      openDashboard: () => void openDashboard(),
      refresh: () => monitor.refreshAll(),
      checkUpdates: () => updater.check(),
      installUpdate: () => updater.install(),
      quit: () => {
        quitting = true
        app.quit()
      }
    })

    const s = monitor.config.settings
    createWidget(s.widgetAlwaysOnTop, s.widgetShowOnStart)
    applySettings()
    monitor.start()
    updater.start()

    // İlk açılışta sunucu yoksa kurulum için dashboard'u göster
    if (monitor.config.servers.length === 0) openDashboard()
  })

  // Tüm pencereler kapansa da tray'de çalışmaya devam et
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    tray?.destroy()
    monitor?.stop()
  })

  app.on('activate', () => openDashboard())
}
