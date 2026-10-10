import { join } from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import { EVT_NAVIGATE } from '@shared/ipc'
import { getLang } from '@shared/i18n'

const WIDGET_W = 340
const MARGIN = 12

let widget: BrowserWindow | null = null
let dashboard: BrowserWindow | null = null

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false
  }
}

function load(win: BrowserWindow, page: 'widget' | 'dashboard', query?: Record<string, string>): void {
  // Renderer ilk çizimde doğru dili kullansın; sonrasında snapshot'taki ayarı izler
  const qs = `?${new URLSearchParams({ ...query, lang: getLang() })}`
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${qs}`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`), { search: qs.slice(1) })
  }
}

/** Renderer'ın başka bir sayfaya gitmesini ve yeni pencere açmasını engeller; https linkleri tarayıcıda açılır. */
function harden(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
}

function widgetBounds(height: number): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const h = Math.max(80, Math.min(Math.round(height), workArea.height - 2 * MARGIN))
  return {
    x: workArea.x + workArea.width - WIDGET_W - MARGIN,
    y: workArea.y + workArea.height - h - MARGIN,
    width: WIDGET_W,
    height: h
  }
}

export function getWidget(): BrowserWindow | null {
  return widget && !widget.isDestroyed() ? widget : null
}

export function createWidget(alwaysOnTop: boolean, show: boolean): BrowserWindow {
  if (getWidget()) return widget!
  widget = new BrowserWindow({
    ...widgetBounds(220),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop,
    show: false,
    hasShadow: true,
    title: 'ServerPulse',
    webPreferences: webPreferences()
  })
  harden(widget)
  load(widget, 'widget')
  if (show) widget.once('ready-to-show', () => widget?.showInactive())
  widget.on('closed', () => {
    widget = null
  })
  // Ekran çözünürlüğü değişince sağ alta yeniden yerleş
  const reposition = (): void => {
    const w = getWidget()
    if (w) w.setBounds(widgetBounds(w.getBounds().height))
  }
  screen.on('display-metrics-changed', reposition)
  widget.on('closed', () => screen.removeListener('display-metrics-changed', reposition))
  return widget
}

export function setWidgetHeight(height: number): void {
  const w = getWidget()
  if (!w || !Number.isFinite(height)) return
  const b = w.getBounds()
  const nb = widgetBounds(height)
  if (Math.abs(b.height - nb.height) < 2) return
  // Kullanıcı widget'ı sürüklediyse yerini koru, sadece alt kenara göre yüksekliği ayarla
  const { workArea } = screen.getDisplayMatching(b)
  const bottom = Math.min(b.y + b.height, workArea.y + workArea.height)
  w.setBounds({ x: b.x, y: Math.max(workArea.y, bottom - nb.height), width: WIDGET_W, height: nb.height })
}

export function toggleWidget(): void {
  const w = getWidget()
  if (!w) return
  if (w.isVisible()) w.hide()
  else {
    w.showInactive()
    w.moveTop()
  }
}

export function setWidgetOnTop(v: boolean): void {
  getWidget()?.setAlwaysOnTop(v, 'floating')
}

export function openDashboard(serverId?: string): BrowserWindow {
  if (dashboard && !dashboard.isDestroyed()) {
    if (dashboard.isMinimized()) dashboard.restore()
    dashboard.show()
    dashboard.focus()
    if (serverId) dashboard.webContents.send(EVT_NAVIGATE, serverId)
    return dashboard
  }
  if (process.platform === 'darwin') void app.dock?.show()
  dashboard = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ServerPulse',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })
  harden(dashboard)
  load(dashboard, 'dashboard', serverId ? { server: serverId } : undefined)
  dashboard.once('ready-to-show', () => dashboard?.show())
  // Kapatınca yok edilir (RAM tasarrufu); uygulama tray'de çalışmaya devam eder
  dashboard.on('closed', () => {
    dashboard = null
    if (process.platform === 'darwin') app.dock?.hide()
  })
  return dashboard
}

export function allWindows(): BrowserWindow[] {
  return [getWidget(), dashboard && !dashboard.isDestroyed() ? dashboard : null].filter((w): w is BrowserWindow => !!w)
}
