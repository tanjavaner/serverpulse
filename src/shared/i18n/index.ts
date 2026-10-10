import { tr, type Messages } from './tr'
import { en } from './en'

/**
 * Küçük, bağımlılıksız çeviri katmanı. Main ve renderer aynı sözlüğü kullanır.
 * - Türkçe (tr.ts) kaynak sözlüktür; en.ts aynı anahtarları sağlamak zorundadır (eksik anahtar derleme hatası).
 * - Parametreler: "{name}". Çoğul (yalnızca gereken dillerde): "{{n|item|items}}" → n === 1 ise ilk biçim.
 * - Etkin dil modül seviyesindedir: main'de ayardan, renderer'da her render'da snapshot'tan ayarlanır.
 */

export type Lang = 'tr' | 'en'
export type LangSetting = 'system' | Lang
export type MsgKey = keyof Messages
export type Params = Record<string, string | number | null | undefined>

const DICTS: Record<Lang, Messages> = { tr, en }
let current: Lang = 'tr'

export function setLang(lang: Lang): void {
  current = lang
}

export function getLang(): Lang {
  return current
}

/** "system" ayarında işletim sisteminin diline bakar; Türkçe dışındaki her dil için İngilizce. */
export function resolveLang(setting: LangSetting | undefined, systemLocale: string | undefined): Lang {
  if (setting === 'tr' || setting === 'en') return setting
  return (systemLocale ?? '').toLowerCase().startsWith('tr') ? 'tr' : 'en'
}

export function isLang(v: unknown): v is Lang {
  return v === 'tr' || v === 'en'
}

export function t(key: MsgKey, params?: Params): string {
  const s: string = DICTS[current][key] ?? tr[key] ?? key
  if (!params) return s
  return s
    .replace(/\{\{(\w+)\|([^|}]*)\|([^}]*)\}\}/g, (_m, k: string, one: string, other: string) => (Number(params[k]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (m, k: string) => (params[k] != null ? String(params[k]) : m))
}

/** Intl API'leri (tarih, sayı) için yerel ayar. */
export function locale(): string {
  return current === 'tr' ? 'tr-TR' : 'en-US'
}

export { tr, en, type Messages }
