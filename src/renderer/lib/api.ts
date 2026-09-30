import { useEffect, useState } from 'react'
import type { RendererApi } from '@shared/ipc'
import type { AppSnapshot } from '@shared/types'

declare global {
  interface Window {
    api: RendererApi
  }
}

export const api = window.api

/** Main process'ten gelen canlı durumu takip eder. */
export function useSnapshot(): AppSnapshot | null {
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void api.invoke('snapshot:get').then((s) => alive && setSnap(s))
    const off = api.onSnapshot((s) => setSnap(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return snap
}

/** Ayardaki temayı (system/light/dark) <html> sınıfına uygular. */
export function useTheme(theme: 'system' | 'light' | 'dark' | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || ((theme ?? 'system') === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}
