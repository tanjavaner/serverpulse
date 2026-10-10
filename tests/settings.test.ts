import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type AppSettings } from '../src/shared/types'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, mergeSettings } from '../src/main/store/config'

describe('ayar doğrulama', () => {
  it('aralık dışı değerleri sınıra çeker', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, {
      intervals: { ...DEFAULT_SETTINGS.intervals, fastSec: 0, mediumSec: 999_999 },
      thresholds: { ...DEFAULT_SETTINGS.thresholds, diskPct: 120 },
      retentionHours: -5
    })
    expect(s.intervals.fastSec).toBe(SETTINGS_LIMITS.intervals.fastSec[0])
    expect(s.intervals.mediumSec).toBe(SETTINGS_LIMITS.intervals.mediumSec[1])
    expect(s.thresholds.diskPct).toBe(99)
    expect(s.retentionHours).toBe(1)
  })

  it('sayı olmayan değer önceki ayarı korur (NaN zamanlayıcıyı kilitlemesin)', () => {
    const base = mergeSettings(DEFAULT_SETTINGS, { intervals: { ...DEFAULT_SETTINGS.intervals, fastSec: 7 } })
    const bad = { intervals: { ...base.intervals, fastSec: Number.NaN, slowSec: '600' as unknown as number } } as Partial<AppSettings>
    const s = mergeSettings(base, bad)
    expect(s.intervals.fastSec).toBe(7)
    expect(s.intervals.slowSec).toBe(base.intervals.slowSec)
  })

  it('eski config dosyasında olmayan yeni eşik varsayılanla gelir', () => {
    const { checkFailAttempts: _omit, ...oldThresholds } = DEFAULT_SETTINGS.thresholds
    const s = mergeSettings(DEFAULT_SETTINGS, { thresholds: oldThresholds as AppSettings['thresholds'] })
    expect(s.thresholds.checkFailAttempts).toBe(DEFAULT_SETTINGS.thresholds.checkFailAttempts)
  })

  it('geçerli değerlere dokunmaz', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS)
  })
})

describe('dil ayarı geçişi', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'sp-cfg-'))

  it('dil ayarı olmayan eski config Türkçe kalır', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, servers: [], projects: [], settings: { theme: 'dark' } }))
    const c = new ConfigStore(dir)
    expect(c.settings.language).toBe('tr')
    expect(c.settings.theme).toBe('dark')
  })

  it('yeni kurulum sistem dilini izler; geçersiz değer reddedilir', () => {
    const c = new ConfigStore(tmp())
    expect(c.settings.language).toBe('system')
    expect(c.updateSettings({ language: 'xx' as never }).language).toBe('system')
    expect(c.updateSettings({ language: 'en' }).language).toBe('en')
  })
})
