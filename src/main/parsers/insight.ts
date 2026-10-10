import type { InodeInfo, ProcessInfo, SecurityState } from '@shared/types'
import { parseSsListen } from './misc'

// Görünürlük toplayıcılarının (süreçler, depolama, güvenlik) saf parse fonksiyonları.
// Bozuk ya da beklenmeyen satırlar atlanır; istisna fırlatılmaz.

const lines = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

/** `ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu` (başlık satırı atlanır; rss KB). */
export function parseProcesses(out: string): ProcessInfo[] {
  const res: ProcessInfo[] = []
  for (const l of lines(out)) {
    const m = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(l)
    if (!m) continue
    res.push({ pid: Number(m[1]), user: m[2], cpuPct: Number(m[3]), memPct: Number(m[4]), rssBytes: Number(m[5]) * 1024, elapsed: m[6], command: m[7] })
  }
  return res
}

/** `df -P -i`: inode desteklemeyen dosya sistemleri (toplam 0 ya da "-") atlanır. */
export function parseInodes(out: string): InodeInfo[] {
  const res: InodeInfo[] = []
  for (const l of lines(out).slice(1)) {
    const f = l.split(/\s+/)
    if (f.length < 6) continue
    const total = Number(f[1])
    const used = Number(f[2])
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) continue
    const pct = Number(f[4].replace('%', ''))
    res.push({ mount: f.slice(5).join(' '), total, used, pct: Number.isFinite(pct) ? pct : Math.round((used / total) * 100) })
  }
  return res
}

/**
 * `docker inspect --format '{{.Name}}|{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}'`
 * json-file sürücüsünde max-size yoksa log dosyası sınırsız büyür (diski doldurmanın klasik nedeni).
 */
export function parseNoLogRotation(out: string): string[] {
  const res: string[] = []
  for (const l of lines(out)) {
    const [name, driver, maxSize] = l.split('|')
    if (!name?.startsWith('/') || driver === undefined) continue
    if (driver === 'json-file' && (!maxSize || maxSize === '<no value>')) res.push(name.slice(1))
  }
  return res.sort()
}

/**
 * journalctl'den ssh başarısız giriş satırları. Her bağlantı (kaynak ip:port) bir deneme sayılır;
 * aynı bağlantıdaki "Invalid user" + "Failed password" satırları iki kez sayılmaz.
 */
export function parseAuthFailures(out: string): SecurityState['auth'] {
  // Yetkisiz kullanıcı: "Hint: You are currently not seeing messages…" ya da hiç dosya açılamadıysa
  // "No journal files were opened due to insufficient permissions." (eski sürümlerde "…were found.")
  if (/not seeing messages from other users|No journal files were (found|opened)/i.test(out)) return { readable: false, attempts: 0, topIps: [] }
  const seen = new Set<string>()
  const perIp = new Map<string, number>()
  for (const l of lines(out)) {
    if (!/Failed (password|publickey) for|Invalid user/.test(l)) continue
    const m = /from ([0-9a-fA-F.:]+) port (\d+)/.exec(l)
    if (!m) continue
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    perIp.set(m[1], (perIp.get(m[1]) ?? 0) + 1)
  }
  const topIps = [...perIp.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([ip, count]) => ({ ip, count }))
  return { readable: true, attempts: seen.size, topIps }
}

/**
 * sshd ayarları: `sshd -T` (root) ya da sshd_config.d/*.conf + sshd_config dosyalarından ilk değer geçerlidir
 * (Ubuntu'da Include satırı dosyanın başında olduğu için .d dosyaları önce okunur). Bulunamazsa OpenSSH varsayılanı.
 */
export function parseSshdConfig(out: string): SecurityState['sshd'] {
  const first = (key: string): string | undefined => {
    for (const l of lines(out)) {
      const m = /^(\S+)\s+(\S+)/.exec(l)
      if (m && m[1].toLowerCase() === key) return m[2].toLowerCase()
    }
    return undefined
  }
  const pw = first('passwordauthentication')
  const kbd = first('kbdinteractiveauthentication')
  const root = first('permitrootlogin')
  return {
    // OpenSSH varsayılanları: PasswordAuthentication yes, PermitRootLogin prohibit-password
    passwordAuth: (pw ?? 'yes') === 'yes' || kbd === 'yes',
    rootLogin: root ?? 'prohibit-password',
    fromDefaults: pw === undefined && root === undefined
  }
}

/** Dinlenen TCP adresleri ("addr:port"); dışa açık (0.0.0.0, ::, *) olanlar ayrıca işaretlenir. */
export function parseListenPorts(out: string): string[] {
  return [...new Set(parseSsListen(out).map((l) => `${l.addr.includes(':') ? `[${l.addr}]` : l.addr}:${l.port}`))].sort()
}

export function isPublicBind(addr: string): boolean {
  return /^(0\.0\.0\.0|\[::\]|\*|\[\*\]):/.test(addr)
}
