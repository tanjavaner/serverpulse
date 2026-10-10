import type { AsteriskState, SystemdUnitState } from '@shared/types'
import { t } from '@shared/i18n'

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

/** `systemctl is-active a b c` her unit için sırayla bir satır basar. */
export function parseIsActive(units: string[], out: string): SystemdUnitState[] {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z-]+$/.test(l))
  return units.map((name, i) => ({ name, state: lines[i] ?? 'unknown' }))
}

/** `systemctl --failed --no-legend --plain` → unit adları */
export function parseFailedUnits(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^[●*]\s*/, ''))
    .filter((l) => l.length > 0 && !/^0 loaded units/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter((u) => /\.(service|socket|mount|timer|target|path|scope|slice)$/.test(u))
}

/** `systemctl list-units --type=service --state=running --no-legend --plain` → ".service" olmadan adlar */
export function parseRunningUnits(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && u.endsWith('.service'))
    .map((u) => u.replace(/\.service$/, ''))
}

// ---------------------------------------------------------------------------
// curl -w '%{http_code} %{time_total}'
// ---------------------------------------------------------------------------

export function parseCurl(out: string, rc: number | null): { ok: boolean; status: number | null; ms: number | null; error?: string } {
  const m = /(\d{3})\s+([\d.]+)\s*$/.exec(out.trim())
  const status = m ? Number(m[1]) : null
  const ms = m ? Math.round(Number(m[2]) * 1000) : null
  if (status == null) return { ok: false, status: null, ms: null, error: t('err.curlUnparsed', { rc }) }
  if (status === 0) {
    const err = rc === 28 ? t('err.timeout') : rc === 7 ? t('err.connRefused') : t('err.curlCode', { rc })
    return { ok: false, status: null, ms, error: err }
  }
  return { ok: status < 500, status, ms, error: status >= 500 ? `HTTP ${status}` : undefined }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

export function parsePgIsReady(out: string, rc: number | null): boolean | null {
  if (/accepting connections/.test(out)) return true
  if (/rejecting connections|no response|no attempt/.test(out)) return false
  if (rc === 0) return true
  if (rc === 1 || rc === 2 || rc === 3) return false
  return null
}

export function parseSingleInt(out: string): number | null {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d+$/.test(l))
  return line ? Number(line) : null
}

export function parseDbSizes(out: string): { name: string; size: number }[] {
  const res: { name: string; size: number }[] = []
  for (const line of out.split('\n')) {
    const m = /^([^|\s]+)\|(\d+)$/.exec(line.trim())
    if (m) res.push({ name: m[1], size: Number(m[2]) })
  }
  return res
}

// ---------------------------------------------------------------------------
// Asterisk
// ---------------------------------------------------------------------------

export function parseChannelsCount(out: string): Pick<AsteriskState, 'activeChannels' | 'activeCalls' | 'callsProcessed'> {
  const num = (re: RegExp): number | null => {
    const m = re.exec(out)
    return m ? Number(m[1]) : null
  }
  return {
    activeChannels: num(/(\d+)\s+active channels?/i),
    activeCalls: num(/(\d+)\s+active calls?/i),
    callsProcessed: num(/(\d+)\s+calls? processed/i)
  }
}

const REG_STATUSES = ['Registered', 'Unregistered', 'Rejected', 'Failed', 'Stopped', 'Trying', 'Auth Sent', 'No Authentication']

export function parseRegistrations(out: string): { name: string; status: string }[] {
  const res: { name: string; status: string }[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('<') || line.startsWith('=') || /^Objects found/i.test(line)) continue
    const status = REG_STATUSES.find((s) => new RegExp(`\\s${s}(\\s|$)`).test(line))
    if (!status) continue
    const name = line.split(/\s+/)[0]
    res.push({ name, status })
  }
  return res
}

export function parseEndpoints(out: string): { name: string; state: string }[] {
  const res: { name: string; state: string }[] = []
  for (const raw of out.split('\n')) {
    const m = /^\s*Endpoint:\s+(\S+)\s+(.+?)\s+\d+\s+of\s+\S+\s*$/.exec(raw)
    if (!m || m[1].startsWith('<')) continue
    res.push({ name: m[1].split('/')[0], state: m[2].trim() })
  }
  return res
}

export function isSudoDenied(out: string): boolean {
  return /a password is required|not allowed to execute|may not run sudo|sudo: .*not found|is not in the sudoers/i.test(out)
}

// ---------------------------------------------------------------------------
// ss -tlnH
// ---------------------------------------------------------------------------

export function parseSsListen(out: string): { addr: string; port: number }[] {
  const res: { addr: string; port: number }[] = []
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    // State Recv-Q Send-Q Local:Port Peer:Port
    const local = f[0] === 'LISTEN' ? f[3] : f[2]
    const m = /^(.*):(\d+)$/.exec(local ?? '')
    if (!m) continue
    res.push({ addr: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) })
  }
  return res
}

// ---------------------------------------------------------------------------
// nginx sites-enabled
// ---------------------------------------------------------------------------

export interface NginxServerBlock {
  file: string
  serverNames: string[]
  ssl: boolean
  proxyPorts: number[]
  primaryPort: number | null
}

function proxyPortsIn(text: string): number[] {
  const ports: number[] = []
  for (const pp of text.matchAll(/\bproxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::(\d+))?/g)) {
    const p = Number(pp[1] ?? 80)
    if (!ports.includes(p)) ports.push(p)
  }
  return ports
}

/** "@@F <dosya>" işaretleyicileriyle birleştirilmiş nginx dosyalarındaki server blokları. */
export function parseNginxSites(out: string): NginxServerBlock[] {
  const blocks: NginxServerBlock[] = []
  const files = out.split(/^@@F /m).filter((s) => s.trim())
  for (const chunk of files) {
    const nl = chunk.indexOf('\n')
    const file = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim()
    const body = (nl >= 0 ? chunk.slice(nl + 1) : '')
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .join('\n')
    // Basit brace sayacıyla üst seviye "server { ... }" bloklarını çıkar
    const re = /\bserver\s*\{/g
    while (re.exec(body)) {
      let depth = 1
      let i = re.lastIndex
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth++
        else if (body[i] === '}') depth--
        i++
      }
      const block = body.slice(re.lastIndex, i - 1)
      re.lastIndex = i
      const names: string[] = []
      for (const sn of block.matchAll(/\bserver_name\s+([^;]+);/g)) {
        for (const n of sn[1].trim().split(/\s+/)) {
          if (n !== '_' && n !== 'localhost' && !n.startsWith('~') && /^[a-zA-Z0-9.*-]+$/.test(n)) names.push(n)
        }
      }
      const ssl = /\blisten\s+[^;]*\b443\b/.test(block) || /\bssl_certificate\b/.test(block)
      const ports = proxyPortsIn(block)
      // Domain'in asıl hedefi "location / { proxy_pass ... }"; yoksa ilk proxy_pass
      const root = /\blocation\s+\/\s*\{([^}]*)\}/.exec(block)
      const primaryPort = (root ? proxyPortsIn(root[1])[0] : undefined) ?? ports[0] ?? null
      if (names.length > 0) blocks.push({ file, serverNames: names, ssl, proxyPorts: ports, primaryPort })
    }
  }
  return blocks
}
