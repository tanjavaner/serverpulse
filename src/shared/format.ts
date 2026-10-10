import { locale, t } from './i18n'

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

/** Türkçede "%12", İngilizcede "12%". */
export function fmtPct(n: number | null | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? '—' : t('fmt.pct', { v: n.toFixed(digits) })
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null) return '—'
  return n >= 1000 ? t('fmt.sec', { n: (n / 1000).toFixed(1) }) : `${Math.round(n)} ms`
}

export function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? t('fmt.uptimeDays', { d, h }) : h > 0 ? t('fmt.uptimeHours', { h, m }) : t('fmt.uptimeMin', { m })
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return t('fmt.agoSec', { n: s })
  if (s < 3600) return t('fmt.agoMin', { n: Math.floor(s / 60) })
  if (s < 86400) return t('fmt.agoHour', { n: Math.floor(s / 3600) })
  return t('fmt.agoDay', { n: Math.floor(s / 86400) })
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function dateOnly(ts: number | string): string {
  return new Date(ts).toLocaleDateString(locale())
}

/** "08.10 14:30" biçiminde kısa tarih-saat. */
export function shortDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
