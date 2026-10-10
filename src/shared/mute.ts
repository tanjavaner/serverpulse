/** Sunucunun tüm sorunlarını kapsayan sessize alma anahtarı. */
export function serverMuteKey(serverId: string): string {
  return `${serverId}:`
}

/** Anahtar tam eşleşirse ya da "sunucuId:" gibi bir önekle sessize alınmışsa bitiş zamanı, değilse null. */
export function mutedUntil(key: string, mutes: Record<string, number> | undefined, now = Date.now()): number | null {
  let until: number | null = null
  for (const [k, u] of Object.entries(mutes ?? {})) {
    if (u > now && (key === k || (k.endsWith(':') && key.startsWith(k)))) until = Math.max(until ?? 0, u)
  }
  return until
}

export function isMuted(key: string, mutes: Record<string, number> | undefined, now = Date.now()): boolean {
  return mutedUntil(key, mutes, now) !== null
}

/** Arayüzdeki hazır süreler: 1 saat, 4 saat, ertesi gün 09:00. */
export function mutePresets(now = new Date()): { id: 'h1' | 'h4' | 'tomorrow'; until: number }[] {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return [
    { id: 'h1', until: now.getTime() + 3600_000 },
    { id: 'h4', until: now.getTime() + 4 * 3600_000 },
    { id: 'tomorrow', until: tomorrow.getTime() }
  ]
}
