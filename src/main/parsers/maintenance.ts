import type { UpgradablePkg } from '@shared/types'

// Bakım komutlarının çıktıları için saf parse fonksiyonları. Bozuk satırlar atlanır, istisna fırlatılmaz.

const lines = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

/** `apt list --upgradable` satırları: "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 amd64 [upgradable from: …]" */
export function parseUpgradable(out: string): UpgradablePkg[] {
  const result: UpgradablePkg[] = []
  for (const l of lines(out)) {
    const m = /^([^/\s]+)\/(\S+)\s+(\S+)/.exec(l)
    if (!m) continue
    result.push({ name: m[1], version: m[3], security: m[2].split(',').some((s) => s.endsWith('-security')) })
  }
  return result
}

/** /var/run/reboot-required.pkgs: satır başına bir paket. */
export function parseRebootPkgs(out: string): string[] {
  return [...new Set(lines(out))]
}

/** reboot-required.pkgs içindeki en yeni linux-image sürümü (ör. "6.8.0-142-generic"). */
export function expectedKernel(pkgs: string[]): string | undefined {
  const versions = pkgs.map((p) => /^linux-image-(\d\S*)$/.exec(p)?.[1]).filter((v): v is string => !!v)
  versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return versions.at(-1)
}

/** "ad|durum|image" satırları (docker ps --format). */
export function parsePsLines(out: string): { name: string; status: string; image: string }[] {
  const result: { name: string; status: string; image: string }[] = []
  for (const l of lines(out)) {
    const [name, status, image] = l.split('|')
    if (!name || status === undefined) continue
    result.push({ name, status, image: image ?? '' })
  }
  return result
}

/** "/ad politika" satırları (docker inspect). Politikası "no" (ya da boş) olanları döner. */
export function parseNoRestart(out: string): string[] {
  const result: string[] = []
  for (const l of lines(out)) {
    const m = /^\/?(\S+)(?:\s+(\S*))?$/.exec(l)
    if (!m) continue
    const policy = m[2] ?? ''
    if (policy === '' || policy === 'no') result.push(m[1])
  }
  return result
}

/** Container çalışıyor ve (healthcheck'i varsa) healthy mi. */
export function containerStatusOk(status: string): boolean {
  return /^Up\b/.test(status) && !/\((unhealthy|health: starting)\)/.test(status)
}

export function containerStarting(status: string): boolean {
  return /^Up\b/.test(status) && /\(health: starting\)/.test(status)
}

export function isDumpComplete(tail: string): boolean {
  return /PostgreSQL database cluster dump complete/.test(tail)
}

/** CMD.maintUpgradePoll çıktısı: "@@RC <kod|boş>\n@@SIZE <n>\n<log baytları>" */
export function parseUpgradePoll(stdout: string): { rc: number | null; size: number | null; chunk: string } {
  const m = /^@@RC ?(\d*)\r?\n@@SIZE (\d+)\r?\n?/.exec(stdout)
  if (!m) return { rc: null, size: null, chunk: '' }
  return { rc: m[1] === '' ? null : Number(m[1]), size: Number(m[2]), chunk: stdout.slice(m[0].length) }
}

/** CMD.maintRestore çıktısı: "@@ERR\n<hata satırları>\n@@TAIL\n<son satırlar>" */
export function parseRestoreOutput(stdout: string): { errors: string[]; tail: string } {
  const i = stdout.indexOf('@@ERR')
  const j = stdout.indexOf('@@TAIL')
  if (i < 0 || j < i) return { errors: [], tail: stdout.trim() }
  return { errors: lines(stdout.slice(i + 5, j)), tail: stdout.slice(j + 6).trim() }
}

/**
 * pg_dumpall yedeği dolu bir kümeye yüklenirken "role/database/relation ... already exists" gibi
 * hatalar beklenir; asıl sorun veri hatalarıdır (duplicate key, syntax error, permission denied …).
 */
export function summarizeRestoreErrors(errors: string[]): { expected: number; real: string[] } {
  const benign = /already exists|multiple primary keys for table/i
  const real = errors.filter((e) => !benign.test(e))
  return { expected: errors.length - real.length, real }
}
