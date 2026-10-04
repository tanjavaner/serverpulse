import { describe, expect, it, vi } from 'vitest'
import type { Issue } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { mergeSettings } from '../src/main/store/config'
import { dispatch, formatText, messageFromIssue, validateTelegram, validateWebhookUrl } from '../src/main/notify/remote'

const issue: Issue = { key: 's1:disk', serverId: 's1', severity: 'crit', title: 'Disk %91 dolu', detail: '/ bölümü', since: 1 }
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

const okResponse = (): Response => new Response('{}', { status: 200 })
const errResponse = (status: number, description: string): Response => new Response(JSON.stringify({ description }), { status })

describe('harici bildirim', () => {
  it('metin biçimi: açılış, düzelme ve test', () => {
    expect(formatText(messageFromIssue(issue, 'open', 'VDS'))).toBe('🔴 Disk %91 dolu\nVDS · / bölümü')
    expect(formatText(messageFromIssue({ ...issue, severity: 'warn' }, 'open'))).toMatch(/^🟠/)
    expect(formatText(messageFromIssue(issue, 'resolved', 'VDS'))).toMatch(/^✅ Düzeldi: Disk/)
    expect(formatText({ kind: 'test', title: 'Test' })).toMatch(/test mesajı/)
  })

  it('doğrulama: token, chat id ve webhook URL', () => {
    expect(() => validateTelegram(TOKEN, '-1001234567890')).not.toThrow()
    expect(() => validateTelegram(TOKEN, '@kanaladi')).not.toThrow()
    expect(() => validateTelegram('bozuk', '123')).toThrow(/token/)
    expect(() => validateTelegram(TOKEN, 'abc def')).toThrow(/Chat ID/)
    expect(validateWebhookUrl('https://hooks.example.com/x')).toBe('https://hooks.example.com/x')
    expect(() => validateWebhookUrl('ftp://x')).toThrow(/http/)
    expect(() => validateWebhookUrl('url değil')).toThrow(/geçersiz/)
  })

  it('Telegram ve webhook doğru gövdeyle çağrılır', async () => {
    const fetchFn = vi.fn(async () => okResponse())
    const rs = await dispatch({ telegram: { token: TOKEN, chatId: '42' }, webhook: { url: 'https://h.example/x' } }, messageFromIssue(issue, 'open', 'VDS'), fetchFn as unknown as typeof fetch)
    expect(rs).toEqual([
      { channel: 'telegram', ok: true },
      { channel: 'webhook', ok: true }
    ])
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(JSON.parse(calls[0][1].body as string)).toMatchObject({ chat_id: '42', text: expect.stringContaining('Disk %91 dolu') })
    const hook = JSON.parse(calls[1][1].body as string)
    expect(hook).toMatchObject({ event: 'open', severity: 'crit', server: 'VDS', key: 's1:disk' })
    expect(hook.text).toBe(hook.content)
  })

  it('bir kanal hata verse diğeri gider; hata metninde token/URL sızmaz', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.includes('telegram') ? errResponse(401, `Unauthorized ${TOKEN}`) : okResponse()))
    const rs = await dispatch({ telegram: { token: TOKEN, chatId: '42' }, webhook: { url: 'https://h.example/x' } }, { kind: 'test', title: 't' }, fetchFn as unknown as typeof fetch)
    expect(rs[0].ok).toBe(false)
    expect(rs[0].error).toContain('401')
    expect(rs[0].error).not.toContain(TOKEN)
    expect(rs[1]).toEqual({ channel: 'webhook', ok: true })
  })

  it('ağ hatası URL içeren mesajda gizlenir', async () => {
    const url = 'https://h.example/secret-path'
    const fetchFn = vi.fn(async () => {
      throw new Error(`connect failed ${url}`)
    })
    const [r] = await dispatch({ webhook: { url } }, { kind: 'test', title: 't' }, fetchFn as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain('secret-path')
  })

  it('ayar birleştirme: kısmi remoteNotify diğer alanları ezmez; varsayılanda kapalı', () => {
    expect(DEFAULT_SETTINGS.remoteNotify.telegram.enabled).toBe(false)
    const merged = mergeSettings(DEFAULT_SETTINGS, { remoteNotify: { telegram: { enabled: true, chatId: '1', hasToken: true }, webhook: DEFAULT_SETTINGS.remoteNotify.webhook } })
    expect(merged.remoteNotify.telegram).toEqual({ enabled: true, chatId: '1', hasToken: true })
    expect(merged.remoteNotify.webhook.enabled).toBe(false)
    // eski config.json (remoteNotify yok) varsayılanlarla açılır
    expect(mergeSettings(DEFAULT_SETTINGS, { retentionHours: 5 }).remoteNotify).toEqual(DEFAULT_SETTINGS.remoteNotify)
  })
})
