import { Menu, Tray, nativeImage } from 'electron'
import type { Severity } from '@shared/types'
import { trayPng } from './icons'

const LABEL: Record<Severity, string> = {
  ok: 'Her şey yolunda',
  warn: 'Uyarı var',
  crit: 'Kritik sorun var',
  unknown: 'Durum bilinmiyor'
}

function image(sev: Severity): Electron.NativeImage {
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: trayPng(16, sev) })
  img.addRepresentation({ scaleFactor: 2, buffer: trayPng(32, sev) })
  return img
}

export interface TrayActions {
  toggleWidget: () => void
  openDashboard: () => void
  refresh: () => void
  checkUpdates: () => void
  installUpdate: () => void
  quit: () => void
}

export class AppTray {
  private tray: Tray
  private cache = new Map<Severity, Electron.NativeImage>()
  private menu: Menu
  private updateVersion: string | null = null

  constructor(private actions: TrayActions) {
    this.tray = new Tray(this.icon('unknown'))
    this.tray.setToolTip('ServerPulse')
    this.menu = this.buildMenu()
    if (process.platform === 'darwin') {
      // macOS: sol tık widget, sağ tık menü
      this.tray.on('click', actions.toggleWidget)
      this.tray.on('right-click', () => this.tray.popUpContextMenu(this.menu))
    } else {
      this.tray.setContextMenu(this.menu)
      this.tray.on('click', actions.toggleWidget)
    }
    this.tray.on('double-click', actions.openDashboard)
  }

  private buildMenu(): Menu {
    const a = this.actions
    const update: Electron.MenuItemConstructorOptions[] = this.updateVersion
      ? [{ label: `Yeniden başlat ve güncelle (v${this.updateVersion})`, click: a.installUpdate }, { type: 'separator' }]
      : []
    return Menu.buildFromTemplate([
      ...update,
      { label: 'Widget’ı göster/gizle', click: a.toggleWidget },
      { label: 'Dashboard', click: a.openDashboard },
      { label: 'Şimdi yenile', click: a.refresh },
      { label: 'Güncellemeleri denetle', click: a.checkUpdates },
      { type: 'separator' },
      { label: 'Çıkış', click: a.quit }
    ])
  }

  setUpdateReady(version: string): void {
    this.updateVersion = version
    this.menu = this.buildMenu()
    if (process.platform !== 'darwin') this.tray.setContextMenu(this.menu)
  }

  private icon(sev: Severity): Electron.NativeImage {
    let img = this.cache.get(sev)
    if (!img) {
      img = image(sev)
      this.cache.set(sev, img)
    }
    return img
  }

  setSeverity(sev: Severity, issueCount: number): void {
    this.tray.setImage(this.icon(sev))
    const update = this.updateVersion ? ` · v${this.updateVersion} hazır` : ''
    this.tray.setToolTip(`ServerPulse: ${LABEL[sev]}${issueCount ? ` (${issueCount} sorun)` : ''}${update}`)
  }

  destroy(): void {
    this.tray.destroy()
  }
}

