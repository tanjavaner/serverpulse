import { useEffect, useState } from 'react'
import type { RendererApi } from '@shared/ipc'
import type { AppSnapshot } from '@shared/types'
import { getLang, isLang, resolveLang, setLang, type LangSetting } from '@shared/i18n'

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

/**
 * Etkin dili ayarlar. Kökte (App/Widget) render sırasında çağrılır; snapshot her geldiğinde ağaç yeniden
 * çizildiği için dil değişikliği tüm bileşenlere yansır. Snapshot gelene kadar main'in URL'ye koyduğu dil geçerlidir.
 */
export function applyLang(setting: LangSetting | undefined): void {
  if (!setting) return
  const lang = resolveLang(setting, navigator.language)
  if (lang === getLang()) return
  setLang(lang)
  document.documentElement.lang = lang
}

/** Main process pencereyi açarken "?lang=" ile o anki dili verir (ilk çizimde yanlış dil görünmesin). */
export function initLangFromUrl(): void {
  const q = new URLSearchParams(location.search).get('lang')
  if (isLang(q)) {
    setLang(q)
    document.documentElement.lang = q
  }
}
