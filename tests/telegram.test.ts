import { describe, expect, it } from 'vitest'
import { parseCommand, summaryDue, TelegramBot, type BotConfig } from '../src/main/notify/telegramBot'
import { issuesText, statusText } from '../src/main/notify/summary'
import { DEFAULT_SETTINGS, type AppSnapshot, type ServerConfig } from '../src/shared/types'

const json = (obj: unknown): Response => ({ ok: true, status: 200, json: async () => obj }) as unknown as Response
const cfg: BotConfig = { enabled: true, token: '123456:' + 'A'.repeat(35), chatId: '123', commands: true, dailySummary: true, summaryTime: '09:00' }

describe('komutlar', () => {
  it('Türkçe/İngilizce komutları ve @BotAdi ekini tanır', () => {
    expect(parseCommand('/durum')).toBe('status')
    expect(parseCommand('/status@ServerPulseBot extra')).toBe('status')
    expect(parseCommand('/SORUNLAR')).toBe('issues')
    expect(parseCommand('/start')).toBe('help')
    expect(parseCommand('merhaba')).toBeNull()
    expect(parseCommand(undefined)).toBeNull()
  })

  it('günlük özet: saat geldiyse, 2 saat içindeyse ve bugün gönderilmediyse', () => {
    const at = (h: number, m: number): Date => new Date(2026, 9, 8, h, m)
    expect(summaryDue(at(8, 59), '09:00', null)).toBe(false)
    expect(summaryDue(at(9, 0), '09:00', null)).toBe(true)
    expect(summaryDue(at(10, 30), '09:00', null)).toBe(true)
    expect(summaryDue(at(11, 30), '09:00', null)).toBe(false)
    expect(summaryDue(at(9, 5), '09:00', at(9, 0).toDateString())).toBe(false)
  })
})

describe('bot', () => {
  it('birikmiş mesajları atlar ve yalnızca kayıtlı sohbete yanıt verir', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    let polls = 0
    const fetchFn = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ method, body })
      if (method === 'sendMessage') return json({ ok: true, result: {} })
      polls++
      if (polls === 1) return json({ ok: true, result: [{ update_id: 5 }] })
      if (polls === 2) {
        return json({
          ok: true,
          result: [
            { update_id: 6, message: { text: '/durum', chat: { id: 999 } } },
            { update_id: 7, message: { text: '/durum@MyBot', chat: { id: 123 } } }
          ]
        })
      }
      // Uzun yoklama: durdurulana kadar bekler
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }) as unknown as typeof fetch

    const bot = new TelegramBot({ getConfig: () => cfg, status: () => 'DURUM', issues: () => 'SORUNLAR', help: () => 'YARDIM', fetchFn })
    bot.start()
    for (let i = 0; i < 100 && !calls.some((c) => c.method === 'sendMessage'); i++) await new Promise((r) => setTimeout(r, 10))
    bot.stop()

    const gets = calls.filter((c) => c.method === 'getUpdates')
    expect(gets[0].body.offset).toBe(-1)
    expect(gets[1].body.offset).toBe(6)
    const sent = calls.filter((c) => c.method === 'sendMessage')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ chat_id: '123', text: 'DURUM' })
  })

  it('günlük özeti günde bir kez gönderir', async () => {
    const sent: unknown[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return json({ ok: true, result: {} })
    }) as unknown as typeof fetch
    const bot = new TelegramBot({ getConfig: () => cfg, status: () => 'ÖZET', issues: () => '', help: () => '', fetchFn })
    expect(await bot.tickSummary(new Date(2026, 9, 8, 9, 1))).toBe(true)
    expect(await bot.tickSummary(new Date(2026, 9, 8, 9, 2))).toBe(false)
    expect(sent).toEqual([expect.objectContaining({ text: 'ÖZET' })])
  })
})

describe('özet metni', () => {
  const srv = (id: string, name: string): ServerConfig => ({
    id, name, host: 'h', port: 22, username: 'u', authType: 'key', systemdUnits: [], asterisk: false, prometheus: false, enabled: true
  })
  const snap: AppSnapshot = {
    servers: [srv('a', 'Ana'), srv('b', 'Yedek')],
    projects: [],
    settings: DEFAULT_SETTINGS,
    overall: 'crit',
    mutes: {},
    issues: [{ key: 'b:unreachable', serverId: 'b', severity: 'crit', title: 'Yedek: sunucuya erişilemiyor', since: 0 }],
    states: {
      a: {
        serverId: 'a', connection: 'ready', errors: {}, http: {}, postgres: {},
        ssl: { 'x.com': { host: 'x.com', ts: 0, daysLeft: 12.7, authorized: true } },
        host: { ts: 0, cpuPct: 12, cores: 2, load: null, memTotal: 1, memUsed: 0.5, memPct: 48, swapTotal: 0, swapUsed: 0, uptimeSec: 1, disks: [{ fs: 'd', mount: '/', size: 10, used: 6, avail: 4, pct: 61 }], memHighSince: null, netRx: null, netTx: null }
      },
      b: { serverId: 'b', connection: 'error', errors: {}, http: {}, ssl: {}, postgres: {} }
    }
  }

  it('kritik sunucu önce; metrikler, sorunlar, SSL ve yedek', () => {
    const text = statusText(snap, Date.UTC(2026, 9, 8, 6, 0), (id) => (id === 'a' ? Date.UTC(2026, 9, 8, 3, 0) : undefined))
    const lines = text.split('\n')
    expect(lines[2]).toBe('🔴 Yedek — Bağlantı hatası')
    expect(lines[3]).toBe('🟢 Ana — CPU %12 · RAM %48 · Disk %61')
    expect(text).toContain('⚠ Açık sorunlar (1):')
    expect(text).toContain('🔒 En yakın SSL bitişi: x.com — 12 gün')
    expect(text).toContain('💾 Son yedek (Ana): 3 sa önce')
  })

  it('sorun yoksa kısa yanıt', () => {
    expect(issuesText({ ...snap, issues: [] })).toBe('✅ Açık sorun yok.')
  })
})
