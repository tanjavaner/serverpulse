import type { Issue } from '@shared/types'
import type { RawIssue } from './evaluate'

export interface AlertTransition {
  opened: Issue[]
  escalated: Issue[]
  resolved: Issue[]
}

/**
 * Flapping'e karşı debounce: bir sorun ancak debounce süresi boyunca kesintisiz görülürse açılır,
 * ancak aynı süre boyunca hiç görülmezse kapanır. Elektron'a bağımlı değildir (test edilebilir).
 */
export class AlertEngine {
  private pending = new Map<string, number>()
  private active = new Map<string, Issue>()
  private missingSince = new Map<string, number>()

  update(raw: RawIssue[], now: number, debounceMs: number, scope?: (key: string) => boolean): AlertTransition {
    const t: AlertTransition = { opened: [], escalated: [], resolved: [] }
    const inScope = scope ?? ((): boolean => true)
    const seen = new Map(raw.map((r) => [r.key, r]))

    for (const r of raw) {
      const cur = this.active.get(r.key)
      if (cur) {
        this.missingSince.delete(r.key)
        const escalated = cur.severity === 'warn' && r.severity === 'crit'
        const next: Issue = { ...cur, severity: r.severity, title: r.title, detail: r.detail, projectId: r.projectId }
        this.active.set(r.key, next)
        if (escalated) t.escalated.push(next)
        continue
      }
      const first = this.pending.get(r.key) ?? now
      this.pending.set(r.key, first)
      if (now - first >= debounceMs) {
        const issue: Issue = { ...r, since: first }
        this.active.set(r.key, issue)
        this.pending.delete(r.key)
        t.opened.push(issue)
      }
    }

    for (const key of [...this.pending.keys()]) {
      if (inScope(key) && !seen.has(key)) this.pending.delete(key)
    }

    for (const [key, issue] of [...this.active]) {
      if (!inScope(key) || seen.has(key)) continue
      const since = this.missingSince.get(key) ?? now
      this.missingSince.set(key, since)
      if (now - since >= debounceMs) {
        this.active.delete(key)
        this.missingSince.delete(key)
        t.resolved.push(issue)
      }
    }
    return t
  }

  /** Sunucu silindiğinde vs. ilgili sorunları sessizce temizler. */
  forget(prefix: string): void {
    for (const m of [this.pending, this.active, this.missingSince]) {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k)
    }
  }

  activeIssues(): Issue[] {
    return [...this.active.values()].sort((a, b) => (a.severity === b.severity ? a.since - b.since : a.severity === 'crit' ? -1 : 1))
  }
}
