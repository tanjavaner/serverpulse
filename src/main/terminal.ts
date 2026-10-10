import { StringDecoder } from 'node:string_decoder'
import type { WebContents } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import type { ActionResult, TermEvent } from '@shared/types'
import { EVT_TERM } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { Monitor } from './monitor'
import { attachKeyboardInteractive, buildConnectConfig, fingerprintOf, maskSecrets } from './ssh/connection'

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_SESSIONS = 8

interface Session {
  client: Client
  stream?: ClientChannel
  owner: WebContents
}

const clamp = (v: number, min: number, max: number): number => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : min)

/**
 * Etkileşimli SSH terminali. İzleme bağlantısından bağımsız, oturum başına ayrı bir SSH bağlantısı açar
 * (izleme kanallarını meşgul etmesin, terminal kapanınca izleme etkilenmesin). Host key her zaman doğrulanır.
 * Yalnızca "Terminale izin ver" ayarı açıkken çalışır; oturum, açan pencere kapanınca kapatılır.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>()

  constructor(private monitor: Monitor) {}

  private emit(id: string, ev: Omit<TermEvent, 'id'>): void {
    const s = this.sessions.get(id)
    if (s && !s.owner.isDestroyed()) s.owner.send(EVT_TERM, { id, ...ev } satisfies TermEvent)
  }

  open(owner: WebContents, serverId: string, id: string, cols: number, rows: number): Promise<ActionResult> {
    if (!this.monitor.config.settings.allowTerminal) return Promise.resolve({ ok: false, error: t('err.terminalDisabled') })
    if (!ID_RE.test(String(id)) || this.sessions.has(id)) return Promise.resolve({ ok: false, error: t('err.badAction') })
    if (this.sessions.size >= MAX_SESSIONS) return Promise.resolve({ ok: false, error: t('err.tooManyTerminals', { n: MAX_SESSIONS }) })
    const server = this.monitor.config.server(serverId)
    if (!server) return Promise.resolve({ ok: false, error: t('err.serverNotFound') })
    const creds = this.monitor.credsFor(serverId)
    if (!creds) return Promise.resolve({ ok: false, error: t('err.noCreds') })
    if (!server.hostKeyFingerprint) return Promise.resolve({ ok: false, error: t('err.hostKeyNotConfirmed') })

    return new Promise((resolve) => {
      const client = new Client()
      let settled = false
      let mismatch = false
      const settle = (r: ActionResult): void => {
        if (settled) return
        settled = true
        resolve(r)
      }
      this.sessions.set(id, { client, owner })
      // Pencere kapanırsa oturum açık kalmasın
      owner.once('destroyed', () => this.close(id))
      attachKeyboardInteractive(client, creds)

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) }, (err, stream) => {
          if (err) {
            settle({ ok: false, error: maskSecrets(err.message, creds) })
            this.close(id)
            return
          }
          const s = this.sessions.get(id)
          if (!s) {
            stream.end()
            return
          }
          s.stream = stream
          // Çok baytlı karakterler parça sınırında bölünmesin
          const out = new StringDecoder('utf8')
          stream.on('data', (d: Buffer) => this.emit(id, { data: out.write(d) }))
          stream.stderr.on('data', (d: Buffer) => this.emit(id, { data: d.toString('utf8') }))
          stream.on('close', () => {
            this.emit(id, { exit: true })
            this.close(id)
          })
          settle({ ok: true })
        })
      })
      client.on('error', (e) => {
        const msg = mismatch ? t('err.fpMismatch') : maskSecrets(e.message, creds)
        if (!settled) settle({ ok: false, error: msg })
        else this.emit(id, { data: `\r\n[${msg}]\r\n` })
      })
      client.on('close', () => {
        if (!settled) settle({ ok: false, error: t('err.connClosed') })
        // Yalnızca açılmış bir kabuk için "oturum kapandı"; bağlanamama hatası open() sonucuyla bildirilir
        if (this.sessions.get(id)?.stream) this.emit(id, { exit: true })
        this.sessions.delete(id)
      })
      try {
        client.connect(
          buildConnectConfig(server, creds, (key) => {
            if (fingerprintOf(key) === server.hostKeyFingerprint) return true
            mismatch = true
            return false
          })
        )
      } catch (e) {
        settle({ ok: false, error: maskSecrets((e as Error).message, creds) })
        this.sessions.delete(id)
      }
    })
  }

  write(id: string, data: string): void {
    // Ayar kapatıldıysa açık oturuma da yazılmaz
    if (!this.monitor.config.settings.allowTerminal) return this.close(id)
    this.sessions.get(id)?.stream?.write(String(data))
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.stream?.setWindow(clamp(rows, 5, 200), clamp(cols, 20, 500), 0, 0)
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    try {
      s.stream?.end()
    } catch {
      /* zaten kapalı */
    }
    s.client.end()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
