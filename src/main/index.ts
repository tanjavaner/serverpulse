import { Notification, app, net, powerMonitor } from 'electron'
import { EVT_MAINT, EVT_SNAPSHOT, EVT_UPDATE } from '@shared/ipc'
import type { AppSnapshot, Issue, MaintEvent, UpdateStatus } from '@shared/types'
import { getLang, resolveLang, setLang, t } from '@shared/i18n'
import { defaultInternetCheck, LOCAL_PREFIX, Monitor } from './monitor'
import { Maintenance } from './maintenance'
import { Updater } from './updater'
import { RemoteNotifier } from './notify'
import { helpText, issuesText, statusText } from './notify/summary'
import { TerminalManager } from './terminal'
import { registerIpc } from './ipc'
import { AppTray } from './tray'
import { allWindows, createWidget, getWidget, openDashboard, setWidgetHeight, setWidgetOnTop, toggleWidget } from './windows'

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let monitor: Monitor
  let tray: AppTray | null = null
  let remoteRef: RemoteNotifier | null = null
  let terms: TerminalManager | null = null
  let quitting = false

  app.setAppUserModelId('com.yukselyazilim.serverpulse')

  app.on('second-instance', () => openDashboard())

  /** Ayardaki dili (system ise işletim sisteminin dilini) uygular; değiştiyse true. */
  const applyLanguage = (): boolean => {
    const lang = resolveLang(monitor.config.settings.language, app.getLocale())
    if (lang === getLang()) return false
    setLang(lang)
    return true
  }

  const applySettings = (): void => {
    const s = monitor.config.settings
    // Tray menüsü main'de çizildiği için dil değişince yeniden kurulur; pencereler snapshot'tan izler
    if (applyLanguage()) tray?.rebuild()
    setWidgetOnTop(s.widgetAlwaysOnTop)
    // Geliştirme modunda electron.exe'yi başlangıca eklememek için sadece paketli sürümde uygula
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin })
  }

  const notify = (issue: Issue, kind: 'open' | 'resolved'): void => {
    if (!monitor.config.settings.notifications || !Notification.isSupported()) return
    const server = monitor.config.server(issue.serverId)
    const n = new Notification({
      title: kind === 'open' ? `${issue.severity === 'crit' ? '🔴' : '🟠'} ${issue.title}` : t('notif.resolved', { title: issue.title }),
      body: [server?.name, issue.detail].filter(Boolean).join(' · '),
      silent: kind === 'resolved'
    })
    n.on('click', () => openDashboard(issue.serverId || undefined))
    n.show()
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide()

    monitor = new Monitor(app.getPath('userData'))
    // net.isOnline false ise ağ arayüzü yok demektir; true ise yine de dışarıya bağlanmayı dene (captive portal vb.)
    monitor.internetCheck = async () => net.isOnline() && (await defaultInternetCheck())
    applyLanguage()

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
          title: t('notif.updateReady', { v: version }),
          body: t('notif.updateBody')
        })
        n.on('click', () => updater.install())
        n.show()
      },
      beforeInstall: () => {
        quitting = true
      }
    })

    const remote = new RemoteNotifier(monitor)
    remote.startBot({
      status: () => statusText(monitor.snapshot(), Date.now(), (id) => maint.lastBackupAt(id)),
      issues: () => issuesText(monitor.snapshot()),
      help: helpText
    })
    remoteRef = remote

    terms = new TerminalManager(monitor)
    registerIpc(monitor, maint, updater, remote, terms, {
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
    // Uyku ya da ağ değişiminden sonra ölü bağlantılar yüzünden yanlış "erişilemiyor" alarmı çıkmasın
    powerMonitor.on('resume', () => monitor.onResume())
    // Bu bilgisayarın internet kesintisi Telegram/webhook'a gönderilmez (zaten ulaşmaz; dönünce gürültü olur)
    monitor.on('alert', (issue: Issue, kind: 'open' | 'resolved') => {
      if (!issue.key.startsWith(LOCAL_PREFIX)) remote.send(issue, kind)
    })

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
    remoteRef?.stopBot()
    terms?.closeAll()
    tray?.destroy()
    monitor?.stop()
  })

  app.on('activate', () => openDashboard())
}
