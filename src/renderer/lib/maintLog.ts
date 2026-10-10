import { useEffect, useState } from 'react'
import type { MaintStep } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * Bakım/deploy işlerinin canlı çıktısı. Sekme ya da ekran değişince kaybolmasın diye modül seviyesinde,
 * sunucu başına tutulur (Bakım sekmesi ve proje ekranı aynı depoyu okur).
 */

export interface LogLine {
  ts: number
  step: MaintStep
  text: string
}

const MAX_LINES = 3000
const logStore = new Map<string, LogLine[]>()
const listeners = new Set<() => void>()
let subscribed = false

function append(serverId: string, line: LogLine): void {
  const arr = logStore.get(serverId) ?? []
  arr.push(line)
  if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES)
  logStore.set(serverId, arr)
  for (const l of listeners) l()
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  api.onMaint((e) => {
    if (e.line !== undefined) append(e.serverId, { ts: Date.now(), step: e.step, text: e.line })
  })
}

/** Arayüzün kendi eklediği satırlar ("▶ … başladı" gibi). */
export function pushLocal(serverId: string, step: MaintStep, text: string): void {
  append(serverId, { ts: Date.now(), step, text })
}

export function useMaintLog(serverId: string): LogLine[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    ensureSubscribed()
    const l = (): void => setTick((x) => x + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return logStore.get(serverId) ?? []
}

export function stepLabel(s: MaintStep): string {
  return t(`maint.step.${s}`)
}
