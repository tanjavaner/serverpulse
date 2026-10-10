import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import type { AgentKind, ConnStatus, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'

export interface Credentials {
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  ms: number
}

const MAX_OUTPUT = 4 * 1024 * 1024
const BACKOFF_SEC = [2, 4, 8, 16, 32, 60]

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function keyAlgorithmOf(key: Buffer): string | undefined {
  if (key.length < 4) return undefined
  const len = key.readUInt32BE(0)
  if (len <= 0 || len > 64 || 4 + len > key.length) return undefined
  return key.subarray(4, 4 + len).toString('ascii')
}

/** Hata mesajlarından olası sırları temizler. */
export function maskSecrets(msg: string, creds?: Credentials | null): string {
  let out = msg
  for (const s of [creds?.password, creds?.passphrase]) {
    if (s && s.length >= 3) out = out.split(s).join('***')
  }
  return out.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, t('err.keyHidden'))
}

/** ssh-agent soketi: Windows'ta OpenSSH agent named pipe'ı ya da Pageant, diğerlerinde SSH_AUTH_SOCK. */
export function agentSocket(kind: AgentKind | undefined, platform = process.platform, env = process.env): string | undefined {
  if (platform === 'win32') return kind === 'pageant' ? 'pageant' : '\\\\.\\pipe\\openssh-ssh-agent'
  return env.SSH_AUTH_SOCK || undefined
}

export function buildConnectConfig(
  server: Pick<ServerConfig, 'host' | 'port' | 'username' | 'authType' | 'agent'>,
  creds: Credentials,
  hostVerifier: (key: Buffer) => boolean
): ConnectConfig {
  const cfg: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    hostVerifier: hostVerifier as ConnectConfig['hostVerifier']
  }
  if (server.authType === 'key') {
    cfg.privateKey = creds.privateKey
    if (creds.passphrase) cfg.passphrase = creds.passphrase
  } else if (server.authType === 'agent') {
    const sock = agentSocket(server.agent)
    if (!sock) throw new Error(t('err.noAgent'))
    cfg.agent = sock
  } else {
    cfg.password = creds.password
    cfg.tryKeyboard = true
  }
  return cfg
}

/** Sunucu şifreyi "keyboard-interactive" ile isterse (KbdInteractiveAuthentication) kayıtlı şifreyle yanıtla. */
export function attachKeyboardInteractive(client: Client, creds: Credentials): void {
  client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
    finish(prompts.map(() => creds.password ?? ''))
  })
}

export class ExecTimeoutError extends Error {}

/** ssh2 kimlik doğrulama hatalarını `level: 'client-authentication'` ile işaretler. */
export function isAuthError(e: unknown): boolean {
  return (e as { level?: string } | null)?.level === 'client-authentication'
}

/** MAX_OUTPUT bayta kadar Buffer biriktirir; metin tek seferde çözülür. */
function byteCollector(): { push: (d: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = []
  let size = 0
  return {
    push: (d: Buffer) => {
      if (size >= MAX_OUTPUT) return
      const part = size + d.length > MAX_OUTPUT ? d.subarray(0, MAX_OUTPUT - size) : d
      chunks.push(part)
      size += part.length
    },
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}

/** Açık bir ssh2 Client üzerinde tek komut çalıştırır. */
export function execOn(client: Client, cmd: string, timeoutMs: number): Promise<ExecResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      // Çok baytlı UTF-8 karakterleri (ğ, ş, …) parça sınırında bölünmesin diye baytlar biriktirilip sonda çözülür
      const out = byteCollector()
      const errOut = byteCollector()
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          stream.close()
        } catch {
          /* yok say */
        }
        reject(new ExecTimeoutError(t('err.cmdTimeout', { n: Math.round(timeoutMs / 1000) })))
      }, timeoutMs)
      stream.on('data', out.push)
      stream.stderr.on('data', errOut.push)
      stream.on('close', (code: number | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ stdout: out.text(), stderr: errOut.text(), code: typeof code === 'number' ? code : null, ms: Date.now() - started })
      })
    })
  })
}

/** Açık bir ssh2 Client üzerinde SFTP ile dosya indirir (get) ya da yükler (put). */
export function sftpTransfer(client: Client, dir: 'get' | 'put', remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err)
      const done = (e?: Error | null): void => {
        sftp.end()
        if (e) reject(e)
        else resolve()
      }
      if (dir === 'get') sftp.fastGet(remotePath, localPath, done)
      else sftp.fastPut(localPath, remotePath, done)
    })
  })
}

/**
 * Tek sunucu için kalıcı SSH bağlantısı. Keepalive, üstel geri çekilmeyle yeniden bağlanma,
 * eşzamanlı kanal sınırı (OpenSSH MaxSessions varsayılanı 10) içerir.
 */
export class SshConnection extends EventEmitter {
  status: ConnStatus = 'idle'
  error?: string
  private client?: Client
  private ready = false
  private attempt = 0
  private timer?: NodeJS.Timeout
  private disposed = false
  private active = 0
  private waiters: (() => void)[] = []

  constructor(
    private getServer: () => ServerConfig | undefined,
    private getCreds: () => Credentials | null,
    private maxChannels = 4
  ) {
    super()
  }

  get isReady(): boolean {
    return this.ready
  }

  start(): void {
    if (this.client || this.disposed) return
    this.connect()
  }

  reconnectNow(): void {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.attempt = 0
    if (this.client) {
      this.client.end()
    } else {
      this.connect()
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.client?.end()
    this.client = undefined
    this.ready = false
    this.removeAllListeners()
  }

  private setStatus(s: ConnStatus, error?: string): void {
    this.status = s
    this.error = error
    this.emit('status', s, error)
  }

  private connect(): void {
    const server = this.getServer()
    if (!server || this.disposed) return
    if (!server.enabled) {
      this.setStatus('disabled')
      return
    }
    const creds = this.getCreds()
    if (!creds) {
      this.setStatus('error', t('err.noCredsStored'))
      return
    }
    if (!server.hostKeyFingerprint) {
      this.setStatus('error', t('err.hostKeyNotConfirmed'))
      return
    }
    const expected = server.hostKeyFingerprint
    let mismatch = false
    let authFailed = false
    const client = new Client()
    this.client = client
    attachKeyboardInteractive(client, creds)
    this.setStatus('connecting')

    client.on('ready', () => {
      this.ready = true
      this.attempt = 0
      this.setStatus('ready')
    })
    client.on('error', (e: Error) => {
      if (isAuthError(e)) authFailed = true
      this.error = maskSecrets(e.message, creds)
    })
    client.on('close', () => {
      const wasReady = this.ready
      this.ready = false
      if (this.client === client) this.client = undefined
      if (this.disposed) return
      if (mismatch) {
        this.setStatus('hostkey-mismatch', t('err.hostKeyMismatch'))
        return // Otomatik yeniden deneme yok
      }
      if (authFailed) {
        // Tekrar tekrar denemek fail2ban'ın bu bilgisayarın IP'sini banlamasına yol açar
        this.setStatus('auth-failed', t('err.authFailed', { e: this.error ?? t('err.authRejected') }))
        return
      }
      this.setStatus('error', this.error ?? (wasReady ? t('err.connLost') : t('err.connFailed')))
      this.scheduleReconnect()
    })

    try {
      client.connect(
        buildConnectConfig(server, creds, (key) => {
          const fp = fingerprintOf(key)
          if (fp !== expected) {
            mismatch = true
            return false
          }
          return true
        })
      )
    } catch (e) {
      this.error = maskSecrets((e as Error).message, creds)
      this.client = undefined
      this.setStatus('error', this.error)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer)
    const delay = BACKOFF_SEC[Math.min(this.attempt, BACKOFF_SEC.length - 1)] * 1000
    this.attempt++
    this.timer = setTimeout(() => this.connect(), delay)
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxChannels) {
      this.active++
      return
    }
    await new Promise<void>((r) => this.waiters.push(r))
    this.active++
  }

  private release(): void {
    this.active--
    this.waiters.shift()?.()
  }

  async exec(cmd: string, timeoutMs = 20000): Promise<ExecResult> {
    if (!this.ready || !this.client) throw new Error(t('err.sshNotReady'))
    await this.acquire()
    try {
      if (!this.client) throw new Error(t('err.sshNotReady'))
      return await execOn(this.client, cmd, timeoutMs)
    } catch (e) {
      const msg = maskSecrets((e as Error).message, this.getCreds())
      throw e instanceof ExecTimeoutError ? new ExecTimeoutError(msg) : new Error(msg)
    } finally {
      this.release()
    }
  }

  forwardOut(dstHost: string, dstPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.client) return reject(new Error(t('err.sshNotReady')))
      this.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => (err ? reject(err) : resolve(stream)))
    })
  }
}

/** Kaydedilmemiş sunucular için (test / host key okuma) geçici bağlantı. */
export function withTempConnection<T>(
  server: Pick<ServerConfig, 'host' | 'port' | 'username' | 'authType' | 'agent'>,
  creds: Credentials,
  expectedFingerprint: string | undefined,
  fn: (client: Client) => Promise<T>,
  onHostKey?: (fp: string, algo?: string) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    attachKeyboardInteractive(client, creds)
    let settled = false
    let mismatch = false
    const finish = (err: Error | null, val?: T): void => {
      if (settled) return
      settled = true
      client.end()
      if (err) reject(new Error(maskSecrets(err.message, creds)))
      else resolve(val as T)
    }
    client.on('ready', () => {
      fn(client).then(
        (v) => finish(null, v),
        (e) => finish(e as Error)
      )
    })
    client.on('error', (e) => finish(mismatch ? new Error(t('err.fpMismatch')) : e))
    client.on('close', () => finish(new Error(t('err.connClosed'))))
    try {
      client.connect(
        buildConnectConfig(server, creds, (key) => {
          const fp = fingerprintOf(key)
          onHostKey?.(fp, keyAlgorithmOf(key))
          if (expectedFingerprint && fp !== expectedFingerprint) {
            mismatch = true
            return false
          }
          return true
        })
      )
    } catch (e) {
      finish(e as Error)
    }
  })
}

/** Kimlik doğrulama yapmadan sadece host key'i okur (TOFU onayı için). */
export function probeHostKey(host: string, port: number): Promise<{ fingerprint: string; algorithm?: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let result: { fingerprint: string; algorithm?: string } | undefined
    const timer = setTimeout(() => {
      client.end()
      reject(new Error(t('err.timeout')))
    }, 15000)
    client.on('error', (e) => {
      clearTimeout(timer)
      if (result) resolve(result)
      else reject(e)
    })
    client.on('close', () => {
      clearTimeout(timer)
      if (result) resolve(result)
    })
    client.connect({
      host,
      port,
      username: 'serverpulse-probe',
      readyTimeout: 15000,
      hostVerifier: ((key: Buffer) => {
        result = { fingerprint: fingerprintOf(key), algorithm: keyAlgorithmOf(key) }
        return false // Doğrulama aşamasına geçmeden bağlantıyı kes
      }) as ConnectConfig['hostVerifier']
    })
  })
}
