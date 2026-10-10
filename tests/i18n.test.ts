import { afterEach, describe, expect, it } from 'vitest'
import { en, getLang, resolveLang, setLang, t, tr } from '../src/shared/i18n'

const params = (s: string): string[] =>
  [...s.matchAll(/\{\{(\w+)\|[^}]*\}\}|\{(\w+)\}/g)].map((m) => m[1] ?? m[2]).filter((v, i, a) => a.indexOf(v) === i).sort()

describe('sözlükler', () => {
  it('İngilizce sözlükte boş çeviri yok', () => {
    const empty = Object.entries(en).filter(([, v]) => !v.trim())
    expect(empty).toEqual([])
  })

  it('her çeviri Türkçe kaynakla aynı parametreleri kullanır', () => {
    const mismatched = (Object.keys(tr) as (keyof typeof tr)[]).filter((k) => params(tr[k]).join(',') !== params(en[k]).join(','))
    expect(mismatched).toEqual([])
  })
})

describe('t()', () => {
  afterEach(() => setLang('tr'))

  it('parametreleri yerleştirir, eksik parametreyi olduğu gibi bırakır', () => {
    expect(t('server.cores', { n: 4 })).toBe('4 çekirdek')
    expect(t('server.cores')).toBe('{n} çekirdek')
  })

  it('İngilizcede tekil/çoğul biçimi seçer', () => {
    setLang('en')
    expect(t('server.cores', { n: 1 })).toBe('1 core')
    expect(t('server.cores', { n: 8 })).toBe('8 cores')
    expect(t('fmt.pct', { v: 42 })).toBe('42%')
  })

  it('Türkçede yüzde işareti başta', () => {
    expect(getLang()).toBe('tr')
    expect(t('fmt.pct', { v: 42 })).toBe('%42')
  })
})

describe('dil seçimi', () => {
  it('system ayarında işletim sistemi dilini izler', () => {
    expect(resolveLang('system', 'tr-TR')).toBe('tr')
    expect(resolveLang('system', 'en-US')).toBe('en')
    expect(resolveLang('system', 'de-DE')).toBe('en')
    expect(resolveLang('tr', 'en-US')).toBe('tr')
    expect(resolveLang(undefined, undefined)).toBe('en')
  })
})
