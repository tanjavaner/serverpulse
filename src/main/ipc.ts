import { mkdirSync } from 'node:fs'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { InvokeApi, InvokeChannel } from '@shared/ipc'
import type { Monitor } from './monitor'
import type { Maintenance } from './maintenance'
import type { Updater } from './updater'
import type { RemoteNotifier } from './notify'
import { discover, getLogs, probe, prometheusQuery, restartContainer, testConnection } from './operations'

type Handlers = { [K in InvokeChannel]: (...args: Parameters<InvokeApi[K]>) => ReturnType<InvokeApi[K]> | Promise<ReturnType<InvokeApi[K]>> }

export interface WindowActions {
  openDashboard: (serverId?: string) => void
  hideWidget: () => void
  setWidgetHeight: (h: number) => void
  applySettings: () => void
}

export function registerIpc(monitor: Monitor, maint: Maintenance, updater: Updater, notifier: RemoteNotifier, win: WindowActions): void {
  const confirm = async (message: string, okLabel = 'Evet, yeniden başlat'): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Vazgeç', okLabel],
      defaultId: 0,
      cancelId: 0,
      title: 'Onay gerekli',
      message
    }
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    return r.response === 1
  }

  const handlers: Handlers = {
    'snapshot:get': () => monitor.snapshot(),
    'server:save': (input) => monitor.saveServer(input),
    'server:remove': (id) => monitor.removeServer(id),
    'server:update': (id, patch) => monitor.patchServer(id, patch),
    'server:probeHostKey': (host, port) => probe(host, Number(port)),
    'server:test': (input) => testConnection(monitor, input),
    'server:discover': (id) => discover(monitor, id),
    'server:pickKeyFile': async () => {
      const parent = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'SSH özel anahtarını seçin',
        properties: ['openFile', 'showHiddenFiles'],
        defaultPath: `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.ssh`
      }
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    'server:reconnect': (id) => monitor.reconnect(id),
    'projects:save': (serverId, projects) => monitor.saveProjects(serverId, projects),
    'project:remove': (id) => monitor.removeProject(id),
    'settings:save': (patch) => {
      // Bildirim kanalları yalnızca 'notify:save' ile değişir (hasToken/hasUrl istemciden gelmemeli)
      const { remoteNotify: _ignored, ...rest } = patch
      const s = monitor.saveSettings(rest)
      win.applySettings()
      return s
    },
    'notify:save': (input) => notifier.save(input),
    'notify:test': () => notifier.test(),
    'logs:get': (serverId, kind, name) => getLogs(monitor, serverId, kind, name),
    'history:host': (serverId, since) => monitor.history.hostSamples(serverId, Number(since)),
    'history:containers': (serverId, since) => monitor.history.containerSamples(serverId, Number(since)),
    'history:http': (ids, since) => monitor.history.httpSamples(Array.isArray(ids) ? ids.map(String) : [], Number(since)),
    'events:list': (limit) => monitor.history.events(Number(limit) || 100),
    'prometheus:query': (serverId, preset, hours) => prometheusQuery(monitor, serverId, preset, Number(hours)),
    'action:restartContainer': (serverId, name) => restartContainer(monitor, serverId, name, confirm),
    'maint:status': (serverId) => maint.status(serverId),
    'maint:backup': (serverId) => maint.backup(serverId, confirm),
    'maint:upgrade': (serverId) => maint.upgrade(serverId, confirm),
    'maint:reboot': (serverId, text) => maint.reboot(serverId, String(text), confirm),
    'maint:postcheck': (serverId) => maint.postcheck(serverId),
    'maint:autoremove': (serverId) => maint.autoremove(serverId, confirm),
    'maint:restore': async (serverId, text) => {
      if (text !== 'RESTORE') return { ok: false, error: 'Onay metni hatalı (RESTORE yazılmalı)' }
      const parent = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Geri yüklenecek yedeği seçin',
        properties: ['openFile'],
        defaultPath: maint.backupDir(serverId),
        filters: [{ name: 'pg_dumpall yedeği', extensions: ['gz'] }]
      }
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return maint.restore(serverId, String(text), r.canceled ? null : (r.filePaths[0] ?? null), confirm)
    },
    'maint:listBackups': (serverId) => maint.listBackups(serverId),
    'maint:openBackupDir': async (serverId) => {
      const dir = maint.backupDir(serverId)
      mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
    },
    'app:refresh': () => monitor.refreshAll(),
    'update:status': () => updater.getStatus(),
    'update:check': () => updater.check(),
    'update:install': () => updater.install(),
    'window:openDashboard': (serverId) => win.openDashboard(serverId),
    'window:hideWidget': () => win.hideWidget(),
    'window:widgetHeight': (h) => win.setWidgetHeight(Number(h))
  }

  for (const [channel, fn] of Object.entries(handlers) as [InvokeChannel, (...a: unknown[]) => unknown][]) {
    ipcMain.handle(channel, async (event, ...args) => {
      // Sadece kendi pencerelerimizden gelen çağrıları kabul et
      const url = event.senderFrame?.url ?? ''
      if (!/^(file:|http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(url)) throw new Error('Yetkisiz IPC kaynağı')
      return fn(...args)
    })
  }
}
