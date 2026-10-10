import { describe, expect, it } from 'vitest'
import { statusMatches } from '../src/shared/http'
import { judgeHttp, splitKeyword } from '../src/main/collectors'
import { CMD, UnsafeInputError } from '../src/main/ssh/commands'
import { parseCurl } from '../src/main/parsers/misc'
import { sanitizeExpectations } from '../src/main/monitor'
import { evaluateServer } from '../src/main/alerts/evaluate'
import { DEFAULT_SETTINGS, type ProjectConfig, type ServerConfig, type ServerState } from '../src/shared/types'

describe('durum kodu kuralı', () => {
  it('tek kod, aralık ve listeleri eşleştirir', () => {
    expect(statusMatches(200, '200')).toBe(true)
    expect(statusMatches(204, '200-299')).toBe(true)
    expect(statusMatches(301, '200-299, 301')).toBe(true)
    expect(statusMatches(404, '200-399')).toBe(false)
    expect(statusMatches(200, 'abc')).toBe(false)
  })
})

describe('yanıt değerlendirmesi', () => {
  it('kural yoksa yalnızca 5xx hata; kural varsa ona göre', () => {
    expect(judgeHttp({ status: 404, ms: 10 }, {}).ok).toBe(true)
    expect(judgeHttp({ status: 502, ms: 10 }, {})).toMatchObject({ ok: false, error: 'HTTP 502' })
    expect(judgeHttp({ status: 404, ms: 10 }, { expectStatus: '200-399' })).toMatchObject({ ok: false, error: 'Beklenmeyen durum kodu: 404' })
  })

  it('anahtar kelime bulunamazsa hata; bağlantı hatası her zaman hata', () => {
    expect(judgeHttp({ status: 200, ms: 10 }, { keyword: 'ok' }, false)).toMatchObject({ ok: false })
    expect(judgeHttp({ status: 200, ms: 10 }, { keyword: 'ok' }, true).ok).toBe(true)
    expect(judgeHttp({ status: null, ms: null, error: 'Zaman aşımı' }, {})).toMatchObject({ ok: false, error: 'Zaman aşımı' })
  })

  it('eşiği aşan başarılı yanıt "yavaş" işaretlenir', () => {
    expect(judgeHttp({ status: 200, ms: 900 }, { slowMs: 500 }).slow).toBe(true)
    expect(judgeHttp({ status: 200, ms: 100 }, { slowMs: 500 }).slow).toBe(false)
  })
})

describe('yerel kontrol komutu', () => {
  it('anahtar kelime grep -F ile aranır, gövde PC\'ye taşınmaz', () => {
    const [s] = CMD.httpLocal([{ host: '127.0.0.1', port: 8080, path: '/health', keyword: '"status":"ok"' }], 5)
    expect(s.cmd).toContain(`grep -qF -- '"status":"ok"'`)
    expect(s.cmd).toContain('(exit $rc)')
    expect(s.cmd).not.toMatch(/(^|;)\s*exit /)
  })

  it('tek tırnak içeren anahtar kelimeyi reddeder', () => {
    expect(() => CMD.httpLocal([{ host: '127.0.0.1', port: 80, keyword: "x'; rm -rf /; '" }], 5)).toThrow(UnsafeInputError)
  })

  it('çıktıdaki @@KW satırını ayırır', () => {
    const r = splitKeyword('200 0.012\n@@KW 1')
    expect(r).toEqual({ out: '200 0.012', found: true })
    expect(parseCurl(r.out, 0)).toMatchObject({ status: 200, ms: 12 })
    expect(splitKeyword('200 0.012')).toEqual({ out: '200 0.012' })
  })
})

describe('beklenti doğrulama', () => {
  it('boşları atar, geçersizleri reddeder', () => {
    expect(sanitizeExpectations({ expectStatus: ' ', keyword: '', slowMs: 0 })).toEqual({ expectStatus: undefined, keyword: undefined, slowMs: undefined })
    expect(() => sanitizeExpectations({ expectStatus: '2xx' })).toThrow()
    expect(() => sanitizeExpectations({ keyword: "a'b" })).toThrow()
    expect(() => sanitizeExpectations({ slowMs: 10 })).toThrow()
    expect(sanitizeExpectations({ expectStatus: '200-299', keyword: 'OK', slowMs: 800 })).toEqual({ expectStatus: '200-299', keyword: 'OK', slowMs: 800 })
  })
})

describe('yavaş yanıt alarmı', () => {
  const server = { id: 's1', name: 'VDS', host: 'h', port: 22, username: 'u', authType: 'key', systemdUnits: [], asterisk: false, prometheus: false, enabled: true } as ServerConfig
  const project: ProjectConfig = {
    id: 'p1', serverId: 's1', name: 'web', containers: [], containerRoles: {}, systemdUnits: [], asterisk: false,
    httpChecks: [{ id: 'h1', name: 'site', role: 'frontend', mode: 'public', url: 'http://x/', slowMs: 500 }]
  }
  const st = (slowStreak: number): ServerState => ({
    serverId: 's1', connection: 'ready', errors: {}, ssl: {}, postgres: {},
    http: { h1: { checkId: 'h1', ts: 0, ok: true, status: 200, ms: 900, failures: 0, slowStreak } }
  })

  it('ardışık eşik aşılınca uyarı', () => {
    const th = DEFAULT_SETTINGS.thresholds
    expect(evaluateServer(server, [project], st(1), th, 0)).toEqual([])
    expect(evaluateServer(server, [project], st(2), th, 0)).toEqual([expect.objectContaining({ key: 's1:http:h1:slow', severity: 'warn' })])
  })
})
