import { contextBridge, ipcRenderer } from 'electron'
import { EVT_MAINT, EVT_NAVIGATE, EVT_SNAPSHOT, EVT_TERM, EVT_UPDATE, INVOKE_CHANNELS, type RendererApi } from '@shared/ipc'
import type { AppSnapshot, MaintEvent, TermEvent, UpdateStatus } from '@shared/types'

const allowed = new Set<string>(INVOKE_CHANNELS)

const api: RendererApi = {
  invoke(channel, ...args) {
    if (!allowed.has(channel)) return Promise.reject(new Error(`İzin verilmeyen kanal: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  onSnapshot(cb) {
    const listener = (_e: unknown, s: AppSnapshot): void => cb(s)
    ipcRenderer.on(EVT_SNAPSHOT, listener)
    return () => ipcRenderer.removeListener(EVT_SNAPSHOT, listener)
  },
  onNavigate(cb) {
    const listener = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on(EVT_NAVIGATE, listener)
    return () => ipcRenderer.removeListener(EVT_NAVIGATE, listener)
  },
  onMaint(cb) {
    const listener = (_e: unknown, ev: MaintEvent): void => cb(ev)
    ipcRenderer.on(EVT_MAINT, listener)
    return () => ipcRenderer.removeListener(EVT_MAINT, listener)
  },
  onUpdate(cb) {
    const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on(EVT_UPDATE, listener)
    return () => ipcRenderer.removeListener(EVT_UPDATE, listener)
  },
  onTerm(cb) {
    const listener = (_e: unknown, ev: TermEvent): void => cb(ev)
    ipcRenderer.on(EVT_TERM, listener)
    return () => ipcRenderer.removeListener(EVT_TERM, listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
