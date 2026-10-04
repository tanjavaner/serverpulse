import type { Issue, NotifyTestResult } from '@shared/types'

export type FetchFn = typeof fetch

export interface RemoteTargets {
  telegram?: { token: string; chatId: string }
  webhook?: { url: string }
}

export interface RemoteMessage {
  kind: 'open' | 'resolved' | 'test'
  severity?: Issue['severity']
  title: string
  detail?: string
  server?: string
  serverId?: string
  key?: string
  since?: number
}

const TIMEOUT_MS = 10_000
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

export function validateTelegram(token: string, chatId: string): void {
  if (!TOKEN_RE.test(token)) throw new Error('Telegram bot token biçimi geçersiz (örn. 123456789:AAH...)')
  if (!CHAT_RE.test(chatId)) throw new Error('Chat ID geçersiz (sayı veya @kanaladi olmalı)')
}

export function validateWebhookUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('Webhook URL geçersiz')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Webhook URL http(s) olmalı')
  return u.toString()
}

export function messageFromIssue(issue: Issue, kind: 'open' | 'resolved', serverName?: string): RemoteMessage {
  return {
    kind,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail,
    server: serverName,
    serverId: issue.serverId,
    key: issue.key,
    since: issue.since
  }
}

export function formatText(m: RemoteMessage): string {
  const head =
    m.kind === 'test' ? '🔔 ServerPulse test mesajı' : m.kind === 'resolved' ? `✅ Düzeldi: ${m.title}` : `${m.severity === 'crit' ? '🔴' : '🟠'} ${m.title}`
  return [head, [m.server, m.detail].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
}

/** Hata metnindeki gizli değerleri (token/URL) temizler. */
function redact(msg: string, secrets: string[]): string {
  let out = msg
  for (const s of secrets) if (s) out = out.split(s).join('***')
  return out
}

async function post(fetchFn: FetchFn, url: string, body: unknown): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
}

export async function sendTelegram(fetchFn: FetchFn, token: string, chatId: string, text: string): Promise<void> {
  const res = await post(fetchFn, `https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text, disable_web_page_preview: true })
  if (!res.ok) {
    let desc = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as { description?: string }
      if (j.description) desc = `${desc}: ${j.description}`
    } catch {
      /* gövde okunamadı */
    }
    throw new Error(desc)
  }
}

export async function sendWebhook(fetchFn: FetchFn, url: string, m: RemoteMessage): Promise<void> {
  const text = formatText(m)
  // text: Slack/Mattermost, content: Discord uyumu için ikisi de gönderilir
  const res = await post(fetchFn, url, { event: m.kind, severity: m.severity, title: m.title, detail: m.detail, server: m.server, serverId: m.serverId, key: m.key, since: m.since, text, content: text })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** Tüm açık kanallara paralel gönderir; bir kanalın hatası diğerini etkilemez. */
export async function dispatch(targets: RemoteTargets, m: RemoteMessage, fetchFn: FetchFn = fetch): Promise<NotifyTestResult[]> {
  const jobs: Promise<NotifyTestResult>[] = []
  if (targets.telegram) {
    const { token, chatId } = targets.telegram
    jobs.push(
      sendTelegram(fetchFn, token, chatId, formatText(m)).then(
        () => ({ channel: 'telegram' as const, ok: true }),
        (e: unknown) => ({ channel: 'telegram' as const, ok: false, error: redact((e as Error).message, [token]) })
      )
    )
  }
  if (targets.webhook) {
    const { url } = targets.webhook
    jobs.push(
      sendWebhook(fetchFn, url, m).then(
        () => ({ channel: 'webhook' as const, ok: true }),
        (e: unknown) => ({ channel: 'webhook' as const, ok: false, error: redact((e as Error).message, [url]) })
      )
    )
  }
  return Promise.all(jobs)
}
