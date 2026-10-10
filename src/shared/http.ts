/**
 * HTTP kontrolü beklentileri: "200", "200-299", "200-399,401" gibi durum kodu kuralları ve anahtar kelime doğrulaması.
 * Saf fonksiyonlar; hem form doğrulamasında (renderer) hem toplayıcıda (main) kullanılır.
 */

export const STATUS_SPEC_RE = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/
/** Sunucuda tek tırnak içinde grep -F'e verilir: tek tırnak, ters bölü ve kontrol karakteri yasak. */
export const KEYWORD_RE = /^[^'\\\x00-\x1f\x7f]{1,100}$/
export const SLOW_MS_RANGE = [50, 60_000] as const

export function statusMatches(status: number, spec: string): boolean {
  if (!STATUS_SPEC_RE.test(spec)) return false
  return spec.split(',').some((part) => {
    const [a, b] = part.split('-').map((x) => Number(x.trim()))
    return b === undefined ? status === a : status >= Math.min(a, b) && status <= Math.max(a, b)
  })
}

export function validSlowMs(v: number): boolean {
  return Number.isInteger(v) && v >= SLOW_MS_RANGE[0] && v <= SLOW_MS_RANGE[1]
}
