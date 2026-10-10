import { SUMMARY_TIME_RE, type Issue, type NotifyTestResult, type RemoteNotifyInput, type AppSettings } from '@shared/types'
import { t } from '@shared/i18n'
import type { Monitor } from '../monitor'
import { dispatch, messageFromIssue, validateTelegram, validateWebhookUrl, type RemoteTargets } from './remote'
import { TelegramBot } from './telegramBot'

/** SecretStore.getText anahtarları (dışa aktarma da kullanır). */
export const K_TOKEN = 'notify.telegram.token'
export const K_URL = 'notify.webhook.url'

/** Harici bildirim kanallarını (Telegram, webhook) ayarlar ve sır deposuyla birleştirir. */
export class RemoteNotifier {
  private bot: TelegramBot | null = null

  constructor(private monitor: Monitor) {}

  /** Telegram komutlarını ve günlük özeti başlatır; metinleri çağıran üretir (durum, sorunlar, yardım). */
  startBot(texts: { status: () => string; issues: () => string; help: () => string }): void {
    this.bot?.stop()
    this.bot = new TelegramBot({
      getConfig: () => {
        const tg = this.monitor.config.settings.remoteNotify.telegram
        return { ...tg, token: this.monitor.secrets.getText(K_TOKEN) }
      },
      ...texts,
      log: (m) => console.error(m)
    })
    this.bot.start()
  }

  stopBot(): void {
    this.bot?.stop()
    this.bot = null
  }

  private targets(onlyEnabled: boolean): RemoteTargets {
    const cfg = this.monitor.config.settings.remoteNotify
    const out: RemoteTargets = {}
    const token = this.monitor.secrets.getText(K_TOKEN)
    if (token && cfg.telegram.chatId && (!onlyEnabled || cfg.telegram.enabled)) out.telegram = { token, chatId: cfg.telegram.chatId }
    const url = this.monitor.secrets.getText(K_URL)
    if (url && (!onlyEnabled || cfg.webhook.enabled)) out.webhook = { url }
    return out
  }

  /** Alarm geçişini açık kanallara gönderir. Hatalar yutulur (günlüğe yazılır); izlemeyi bozmamalı. */
  send(issue: Issue, kind: 'open' | 'resolved'): void {
    const targets = this.targets(true)
    if (!targets.telegram && !targets.webhook) return
    const server = this.monitor.config.server(issue.serverId)?.name
    void dispatch(targets, messageFromIssue(issue, kind, server)).then((rs) => {
      for (const r of rs) if (!r.ok) console.error(`[notify:${r.channel}] gönderilemedi: ${r.error}`)
    })
  }

  /** Ayarlardaki enabled bayrağına bakmadan, kayıtlı kanallara test mesajı gönderir. */
  async test(): Promise<NotifyTestResult[]> {
    const targets = this.targets(false)
    if (!targets.telegram && !targets.webhook) return [{ channel: 'telegram', ok: false, error: t('rn.noChannel') }]
    return dispatch(targets, { kind: 'test', title: 'Test', detail: t('rn.testDetail') })
  }

  /** Doğrular, sırları safeStorage'a yazar, ayarlara yalnızca gizli olmayan alanları yansıtır. */
  save(input: RemoteNotifyInput): AppSettings {
    const { telegram: tg, webhook: w } = input
    const secrets = this.monitor.secrets
    const chatId = (tg.chatId ?? '').trim()

    const token = tg.token?.trim()
    if (tg.clearToken) secrets.setText(K_TOKEN, null)
    else if (token) {
      validateTelegram(token, chatId)
      secrets.setText(K_TOKEN, token)
    }
    const url = w.url?.trim()
    if (w.clearUrl) secrets.setText(K_URL, null)
    else if (url) secrets.setText(K_URL, validateWebhookUrl(url))

    const hasToken = !!secrets.getText(K_TOKEN)
    const hasUrl = !!secrets.getText(K_URL)
    if (tg.enabled && (!hasToken || !chatId)) throw new Error(t('rn.needTelegram'))
    if (tg.enabled && token === undefined && chatId) validateTelegram(secrets.getText(K_TOKEN) ?? '', chatId)
    if (w.enabled && !hasUrl) throw new Error(t('rn.needWebhook'))

    // Verilmeyen ek alanlar mevcut ayardan korunur
    const prev = this.monitor.config.settings.remoteNotify.telegram
    const summaryTime = tg.summaryTime ?? prev.summaryTime
    if (!SUMMARY_TIME_RE.test(summaryTime)) throw new Error(t('rn.badTime'))
    // Token ya da sohbet değişmiş olabilir: süren uzun yoklama yeni ayarlarla baştan başlasın
    this.bot?.refresh()
    return this.monitor.saveSettings({
      remoteNotify: {
        telegram: {
          enabled: !!tg.enabled,
          chatId,
          hasToken,
          commands: tg.commands ?? prev.commands,
          dailySummary: tg.dailySummary ?? prev.dailySummary,
          summaryTime
        },
        webhook: { enabled: !!w.enabled, hasUrl }
      }
    })
  }
}
