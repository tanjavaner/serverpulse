import type { Issue, NotifyTestResult, RemoteNotifyInput, AppSettings } from '@shared/types'
import type { Monitor } from '../monitor'
import { dispatch, messageFromIssue, validateTelegram, validateWebhookUrl, type RemoteTargets } from './remote'

const K_TOKEN = 'notify.telegram.token'
const K_URL = 'notify.webhook.url'

/** Harici bildirim kanallarını (Telegram, webhook) ayarlar ve sır deposuyla birleştirir. */
export class RemoteNotifier {
  constructor(private monitor: Monitor) {}

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
    if (!targets.telegram && !targets.webhook) return [{ channel: 'telegram', ok: false, error: 'Kayıtlı kanal yok (önce token/URL kaydedin)' }]
    return dispatch(targets, { kind: 'test', title: 'Test', detail: 'Bildirim kanalı çalışıyor.' })
  }

  /** Doğrular, sırları safeStorage'a yazar, ayarlara yalnızca gizli olmayan alanları yansıtır. */
  save(input: RemoteNotifyInput): AppSettings {
    const { telegram: t, webhook: w } = input
    const secrets = this.monitor.secrets
    const chatId = (t.chatId ?? '').trim()

    const token = t.token?.trim()
    if (t.clearToken) secrets.setText(K_TOKEN, null)
    else if (token) {
      validateTelegram(token, chatId)
      secrets.setText(K_TOKEN, token)
    }
    const url = w.url?.trim()
    if (w.clearUrl) secrets.setText(K_URL, null)
    else if (url) secrets.setText(K_URL, validateWebhookUrl(url))

    const hasToken = !!secrets.getText(K_TOKEN)
    const hasUrl = !!secrets.getText(K_URL)
    if (t.enabled && (!hasToken || !chatId)) throw new Error('Telegram için token ve chat ID gerekli')
    if (t.enabled && token === undefined && chatId) validateTelegram(secrets.getText(K_TOKEN) ?? '', chatId)
    if (w.enabled && !hasUrl) throw new Error('Webhook için URL gerekli')

    return this.monitor.saveSettings({
      remoteNotify: { telegram: { enabled: !!t.enabled, chatId, hasToken }, webhook: { enabled: !!w.enabled, hasUrl } }
    })
  }
}
