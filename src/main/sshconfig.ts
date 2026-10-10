import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshConfigHost } from '@shared/types'

/**
 * ~/.ssh/config içindeki somut Host bloklarını okur (HostName, User, Port, IdentityFile).
 * Joker (*, ?) ve olumsuz (!) desenler, Match blokları ve Include atlanır: amaç formu doldurmak, ssh'ı taklit etmek değil.
 */
export function parseSshConfig(text: string, home: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = unquote(m[2].trim())
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((p) => p && !/[*?!]/.test(p))
        .map((alias) => ({ alias, host: alias }))
      hosts.push(...current)
      continue
    }
    if (key === 'match') {
      current = []
      continue
    }
    for (const h of current) {
      // ssh'ta ilk değer geçerlidir
      if (key === 'hostname' && h.host === h.alias) h.host = value
      else if (key === 'user' && !h.user) h.user = value
      else if (key === 'port' && !h.port && /^\d{1,5}$/.test(value)) h.port = Number(value)
      else if (key === 'identityfile' && !h.identityFile) h.identityFile = expandPath(value, home)
    }
  }
  // Aynı alias birden çok kez tanımlandıysa ilki kalır
  return hosts.filter((h, i) => hosts.findIndex((x) => x.alias === h.alias) === i)
}

function unquote(v: string): string {
  return /^".*"$/.test(v) ? v.slice(1, -1) : v
}

function expandPath(p: string, home: string): string {
  const v = p.replace(/%d/g, home).replace(/^~(?=$|[\\/])/, home)
  return v
}

/** Kullanıcının ssh config dosyasını okur; yoksa boş liste. */
export function readSshConfigHosts(): SshConfigHost[] {
  const home = homedir()
  const file = join(home, '.ssh', 'config')
  if (!existsSync(file)) return []
  try {
    return parseSshConfig(readFileSync(file, 'utf8'), home).map((h) => ({
      ...h,
      identityFile: h.identityFile && existsSync(h.identityFile) ? h.identityFile : undefined
    }))
  } catch {
    return []
  }
}
