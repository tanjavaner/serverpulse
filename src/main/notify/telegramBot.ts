import type { FetchFn } from './remote'
import { sendTelegram } from './remote'

/**
 * Telegram komutları (/durum, /sorunlar) ve günlük özet. getUpdates ile uzun yoklama yapar; webhook kurmaz,
 * dışarıdan bağlantı kabul etmez. Yalnızca ayarlardaki chat ID'den gelen mesajlara yanıt verir ve hiçbir komut
 * sunucuda değişiklik yapmaz.
 */

export interface BotConfig {
  enabled: boolean
  token: string | null
  chatId: string
  commands: boolean
  dailySummary: boolean
  summaryTime: string
}

export interface BotDeps {
  getConfig: () => BotConfig
  status: () => string
  issues: () => string
  help: () => string
  fetchFn?: FetchFn
  log?: (msg: string) => void
}

interface Update {
  update_id: number
  message?: { text?: string; chat?: { id?: number | string } }
}

const POLL_SEC = 25
const IDLE_MS = 15_000
/** Uygulama özet saatinde kapalı/uykudaysa bu süre içinde açılınca yine gönderilir. */
const SUMMARY_GRACE_MS = 2 * 3600_000

const COMMANDS: Record<string, 'status' | 'issues' | 'help'> = {
  '/durum': 'status',
  '/status': 'status',
  '/sorunlar': 'issues',
  '/issues': 'issues',
  '/start': 'help',
  '/yardim': 'help',
  '/help': 'help'
}

/** "/durum@BotAdi argüman" → "status"; komut değilse null. */
export function parseCommand(text: string | undefined): 'status' | 'issues' | 'help' | null {
  const word = (text ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, '') ?? ''
  return COMMANDS[word] ?? null
}

/** Bugünkü özet gönderilmeli mi: saat geçtiyse, son iki saat içindeyse ve bugün gönderilmediyse. */
export function summaryDue(now: Date, summaryTime: string, lastSentDay: string | null): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(summaryTime)
  if (!m) return false
  const at = new Date(now)
  at.setHours(Number(m[1]), Number(m[2]), 0, 0)
  const diff = now.getTime() - at.getTime()
  return diff >= 0 && diff < SUMMARY_GRACE_MS && lastSentDay !== now.toDateString()
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

export class TelegramBot {
  private running = false
  private offset: number | null = null
  private poll = new AbortController()
  private stopper = new AbortController()
  private summaryTimer?: NodeJS.Timeout
  private lastSummaryDay: string | null = null
  private fetchFn: FetchFn

  constructor(private deps: BotDeps) {
    this.fetchFn = deps.fetchFn ?? fetch
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopper = new AbortController()
    void this.loop()
    this.summaryTimer = setInterval(() => void this.tickSummary(new Date()), 30_000)
  }

  stop(): void {
    this.running = false
    this.stopper.abort()
    this.poll.abort()
    clearInterval(this.summaryTimer)
  }

  /** Ayarlar değişti: süren yoklamayı kes, yeni token/chat ile baştan başla (birikmiş mesajlar atlanır). */
  refresh(): void {
    this.offset = null
    this.poll.abort()
  }

  private async call<T>(token: string, method: string, body: unknown, timeoutMs: number): Promise<T> {
    this.poll = new AbortController()
    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.poll.signal])
    })
    const j = (await res.json()) as { ok: boolean; result: T; description?: string }
    if (!j.ok) throw Object.assign(new Error(j.description ?? `HTTP ${res.status}`), { status: res.status })
    return j.result
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const cfg = this.deps.getConfig()
      if (!cfg.enabled || !cfg.commands || !cfg.token || !/^-?\d+$/.test(cfg.chatId)) {
        await sleep(IDLE_MS, this.stopper.signal)
        continue
      }
      try {
        if (this.offset === null) {
          // Uygulama kapalıyken yazılmış eski komutlara toplu yanıt verme: en son güncellemenin ötesinden başla
          const last = await this.call<Update[]>(cfg.token, 'getUpdates', { offset: -1, timeout: 0 }, 15_000)
          this.offset = last.length ? last[last.length - 1].update_id + 1 : 0
          continue
        }
        const updates = await this.call<Update[]>(cfg.token, 'getUpdates', { offset: this.offset, timeout: POLL_SEC, allowed_updates: ['message'] }, (POLL_SEC + 10) * 1000)
        for (const u of updates) {
          this.offset = u.update_id + 1
          await this.handle(u, cfg)
        }
      } catch (e) {
        if (!this.running) return
        // Kullanıcı ayarı değiştirdiyse (refresh) hemen devam; 409: başka bir yerde aynı bot okunuyor
        if (this.poll.signal.aborted && !this.stopper.signal.aborted) continue
        const status = (e as { status?: number }).status
        this.deps.log?.(`[telegram] ${status === 409 ? 'getUpdates çakışması (başka bir istemci aynı botu kullanıyor)' : (e as Error).message.replace(cfg.token, '***')}`)
        await sleep(status === 409 ? 60_000 : IDLE_MS, this.stopper.signal)
      }
    }
  }

  private async handle(u: Update, cfg: BotConfig): Promise<void> {
    const chat = u.message?.chat?.id
    // Yalnızca ayarlardaki sohbet: başkaları botu bulsa bile hiçbir bilgi almaz
    if (chat === undefined || String(chat) !== cfg.chatId || !cfg.token) return
    const cmd = parseCommand(u.message?.text)
    if (!cmd) return
    const text = cmd === 'status' ? this.deps.status() : cmd === 'issues' ? this.deps.issues() : this.deps.help()
    await sendTelegram(this.fetchFn, cfg.token, cfg.chatId, text)
  }

  async tickSummary(now: Date): Promise<boolean> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled || !cfg.dailySummary || !cfg.token || !cfg.chatId) return false
    if (!summaryDue(now, cfg.summaryTime, this.lastSummaryDay)) return false
    this.lastSummaryDay = now.toDateString()
    try {
      await sendTelegram(this.fetchFn, cfg.token, cfg.chatId, this.deps.status())
      return true
    } catch (e) {
      this.deps.log?.(`[telegram] özet gönderilemedi: ${(e as Error).message.replace(cfg.token, '***')}`)
      return false
    }
  }
}
