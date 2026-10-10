import { Menu, Tray, nativeImage } from 'electron'
import type { Severity } from '@shared/types'
import { t } from '@shared/i18n'
import { trayPng } from './icons'

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
  private last: { sev: Severity; count: number } = { sev: 'unknown', count: 0 }

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
      ? [{ label: t('tray.installUpdate', { v: this.updateVersion }), click: a.installUpdate }, { type: 'separator' }]
      : []
    return Menu.buildFromTemplate([
      ...update,
      { label: t('tray.toggleWidget'), click: a.toggleWidget },
      { label: t('tray.dashboard'), click: a.openDashboard },
      { label: t('tray.refresh'), click: a.refresh },
      { label: t('tray.checkUpdates'), click: a.checkUpdates },
      { type: 'separator' },
      { label: t('tray.quit'), click: a.quit }
    ])
  }

  setUpdateReady(version: string): void {
    this.updateVersion = version
    this.rebuild()
  }

  /** Dil değişince menü ve ipucu metnini yeniden üretir. */
  rebuild(): void {
    this.menu = this.buildMenu()
    if (process.platform !== 'darwin') this.tray.setContextMenu(this.menu)
    this.setSeverity(this.last.sev, this.last.count)
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
    this.last = { sev, count: issueCount }
    this.tray.setImage(this.icon(sev))
    const update = this.updateVersion ? t('tray.updateReady', { v: this.updateVersion }) : ''
    this.tray.setToolTip(`ServerPulse: ${t(`tray.${sev}`)}${issueCount ? t('tray.issues', { n: issueCount }) : ''}${update}`)
  }

  destroy(): void {
    this.tray.destroy()
  }
}

