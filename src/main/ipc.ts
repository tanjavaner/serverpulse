import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { InvokeApi, InvokeChannel } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { Monitor } from './monitor'
import type { Maintenance } from './maintenance'
import type { Updater } from './updater'
import type { RemoteNotifier } from './notify'
import type { TerminalManager } from './terminal'
import { containerAction, discover, getLogs, listProcesses, probe, prometheusQuery, pruneDocker, publicKeyLine, testConnection } from './operations'
import { readSshConfigHosts } from './sshconfig'
import { applyImport, buildExport, parseExport, WrongPasswordError } from './transfer'

/** `this`: çağrıyı yapan pencerenin olayı (terminal çıktısını yalnızca o pencereye göndermek için). */
type Handlers = {
  [K in InvokeChannel]: (this: Electron.IpcMainInvokeEvent, ...args: Parameters<InvokeApi[K]>) => ReturnType<InvokeApi[K]> | Promise<ReturnType<InvokeApi[K]>>
}

export interface WindowActions {
  openDashboard: (serverId?: string) => void
  hideWidget: () => void
  setWidgetHeight: (h: number) => void
  applySettings: () => void
}

function readExport(path: string): ReturnType<typeof parseExport> {
  if (statSync(path).size > 10 * 1024 * 1024) throw new Error(t('xfer.notExport'))
  return parseExport(readFileSync(path, 'utf8'))
}

export function registerIpc(monitor: Monitor, maint: Maintenance, updater: Updater, notifier: RemoteNotifier, terms: TerminalManager, win: WindowActions): void {
  const confirm = async (message: string, okLabel = t('dlg.yesRestart')): Promise<boolean> => {
    const parent = BrowserWindow.getFocusedWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [t('dlg.cancel'), okLabel],
      defaultId: 0,
      cancelId: 0,
      title: t('dlg.confirmTitle'),
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
        title: t('dlg.pickKey'),
        properties: ['openFile', 'showHiddenFiles'],
        defaultPath: `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.ssh`
      }
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    'server:reconnect': (id) => monitor.reconnect(id),
    'server:publicKey': (input) => publicKeyLine(monitor, input ?? {}),
    'server:sshConfigHosts': () => readSshConfigHosts(),
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
    'logs:get': (serverId, kind, name, opts) => getLogs(monitor, serverId, kind, name, opts ?? {}),
    'logs:save': async (name, text) => {
      const parent = BrowserWindow.getFocusedWindow()
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const dOpts: Electron.SaveDialogOptions = {
        title: t('dlg.saveLog'),
        defaultPath: `${String(name).replace(/[^A-Za-z0-9_.-]/g, '_')}-${stamp}.log`,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
      }
      const r = parent ? await dialog.showSaveDialog(parent, dOpts) : await dialog.showSaveDialog(dOpts)
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true }
      writeFileSync(r.filePath, String(text), 'utf8')
      return { ok: true, path: r.filePath }
    },
    'history:host': (serverId, since) => monitor.history.hostSamples(serverId, Number(since)),
    'history:containers': (serverId, since) => monitor.history.containerSamples(serverId, Number(since)),
    'history:http': (ids, since) => monitor.history.httpSamples(Array.isArray(ids) ? ids.map(String) : [], Number(since)),
    'history:hostRollup': (serverId, since) => monitor.history.hostRollup(serverId, Number(since)),
    'history:uptime': (ids) => monitor.history.uptime(Array.isArray(ids) ? ids.map(String).slice(0, 100) : []),
    'host:processes': (serverId) => listProcesses(monitor, String(serverId)),
    'security:acceptPorts': (serverId) => monitor.acceptPorts(String(serverId)),
    'events:list': (limit) => monitor.history.events(Number(limit) || 100),
    'alerts:mute': (key, until) => monitor.mute(String(key), Number(until)),
    'alerts:unmute': (key) => monitor.unmute(String(key)),
    'prometheus:query': (serverId, preset, hours) => prometheusQuery(monitor, serverId, preset, Number(hours)),
    'action:container': (serverId, name, action) => containerAction(monitor, serverId, name, action, confirm),
    'action:prune': (serverId, mode) => pruneDocker(monitor, serverId, mode === 'images' ? 'images' : 'safe', confirm),
    'maint:status': (serverId) => maint.status(serverId),
    'maint:backup': (serverId) => maint.backup(serverId, confirm),
    'maint:upgrade': (serverId) => maint.upgrade(serverId, confirm),
    'maint:reboot': (serverId, text) => maint.reboot(serverId, String(text), confirm),
    'maint:postcheck': (serverId) => maint.postcheck(serverId),
    'maint:autoremove': (serverId) => maint.autoremove(serverId, confirm),
    'maint:restore': async (serverId, text) => {
      if (text !== 'RESTORE') return { ok: false, error: t('err.restoreText') }
      const parent = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: t('dlg.pickBackup'),
        properties: ['openFile'],
        defaultPath: maint.backupDir(serverId),
        filters: [{ name: t('dlg.backupFilter'), extensions: ['gz'] }]
      }
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return maint.restore(serverId, String(text), r.canceled ? null : (r.filePaths[0] ?? null), confirm)
    },
    'maint:listBackups': (serverId) => maint.listBackups(serverId),
    'maint:deploy': (serverId, projectId) => maint.deploy(serverId, String(projectId), confirm),
    'maint:openBackupDir': async (serverId) => {
      const dir = maint.backupDir(serverId)
      mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
    },
    'app:refresh': () => monitor.refreshAll(),
    'app:copy': (text) => clipboard.writeText(String(text).slice(0, 100_000)),
    'term:open': function (serverId, id, cols, rows) {
      return terms.open(this.sender, String(serverId), String(id), Number(cols), Number(rows))
    },
    'term:write': (id, data) => terms.write(String(id), String(data)),
    'term:resize': (id, cols, rows) => terms.resize(String(id), Number(cols), Number(rows)),
    'term:close': (id) => terms.close(String(id)),
    'config:export': async (opts) => {
      try {
        // Parola kontrolü diyalogdan önce: kullanıcı dosya seçtikten sonra hata görmesin
        const file = buildExport(monitor, app.getVersion(), { includeSecrets: !!opts?.includeSecrets, password: opts?.password })
        const parent = BrowserWindow.getFocusedWindow()
        const dOpts: Electron.SaveDialogOptions = {
          title: t('xfer.exportTitle'),
          defaultPath: `serverpulse-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        }
        const r = parent ? await dialog.showSaveDialog(parent, dOpts) : await dialog.showSaveDialog(dOpts)
        if (r.canceled || !r.filePath) return { ok: false, cancelled: true }
        writeFileSync(r.filePath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
        return { ok: true, path: r.filePath }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    'config:inspectImport': async () => {
      try {
        const parent = BrowserWindow.getFocusedWindow()
        const dOpts: Electron.OpenDialogOptions = { title: t('xfer.importTitle'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }
        const r = parent ? await dialog.showOpenDialog(parent, dOpts) : await dialog.showOpenDialog(dOpts)
        const path = r.filePaths[0]
        if (r.canceled || !path) return { ok: false, cancelled: true }
        const f = readExport(path)
        return { ok: true, path, servers: f.servers.length, projects: f.projects.length, encrypted: !!f.secrets, exportedAt: f.exportedAt }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    'config:import': (path, opts) => {
      try {
        const r = applyImport(monitor, readExport(String(path)), { password: opts?.password || undefined, settings: !!opts?.settings })
        if (opts?.settings) win.applySettings()
        return r
      } catch (e) {
        return { ok: false, added: 0, skipped: 0, errors: [], needsPassword: e instanceof WrongPasswordError, error: (e as Error).message }
      }
    },
    'update:status': () => updater.getStatus(),
    'update:check': () => updater.check(),
    'update:install': () => updater.install(),
    'window:openDashboard': (serverId) => win.openDashboard(serverId),
    'window:hideWidget': () => win.hideWidget(),
    'window:widgetHeight': (h) => win.setWidgetHeight(Number(h))
  }

  for (const [channel, fn] of Object.entries(handlers) as [InvokeChannel, (this: Electron.IpcMainInvokeEvent, ...a: unknown[]) => unknown][]) {
    ipcMain.handle(channel, async (event, ...args) => {
      // Sadece kendi pencerelerimizden gelen çağrıları kabul et
      const url = event.senderFrame?.url ?? ''
      if (!/^(file:|http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(url)) throw new Error(t('err.unauthorizedIpc'))
      return fn.apply(event, args)
    })
  }
}
