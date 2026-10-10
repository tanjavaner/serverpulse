import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LogOptions, LogResult } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { Alert, Button } from '../components/ui'

export interface LogTarget {
  serverId: string
  kind: 'container' | 'unit'
  name: string
}

const LINES: NonNullable<LogOptions['lines']>[] = [200, 1000, 5000]
const SINCE: (LogOptions['since'] | '')[] = ['', '15m', '1h', '24h']
const AUTO_MS = 5000
/** Otomatik yenileme bu süreden sonra kendiliğinden durur (unutulan pencere sunucuyu yoklamaya devam etmesin). */
const AUTO_MAX_MS = 10 * 60_000

/** Son N satır (takip modu yok); otomatik yenileme her seferinde yeniden okur, sunucuda süreç bırakmaz. */
export function LogViewer({ target, onClose }: { target: LogTarget; onClose: () => void }): ReactNode {
  const [res, setRes] = useState<LogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [lines, setLines] = useState<NonNullable<LogOptions['lines']>>(200)
  const [since, setSince] = useState<LogOptions['since'] | ''>('')
  const [autoSince, setAutoSince] = useState<number | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  const load = async (): Promise<void> => {
    setLoading(true)
    setRes(await api.invoke('logs:get', target.serverId, target.kind, target.name, { lines, since: since || undefined }))
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.serverId, target.kind, target.name, lines, since])

  // Otomatik yenileme: 5 sn'de bir, en fazla 10 dk
  useEffect(() => {
    if (autoSince === null) return
    const timer = setInterval(() => {
      if (Date.now() - autoSince > AUTO_MAX_MS) setAutoSince(null)
      else void load()
    }, AUTO_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSince, lines, since])

  // Kullanıcı yukarı kaydırmadıysa en alta yapış
  useEffect(() => {
    if (preRef.current && stick.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [res])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    const r = await api.invoke('logs:save', target.name, res?.lines ?? '')
    if (r.ok && r.path) {
      setSaved(r.path)
      setTimeout(() => setSaved(null), 4000)
    }
  }

  const all = (res?.lines ?? '').split('\n')
  const shown = filter ? all.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : all
  const cmd = target.kind === 'container' ? `docker logs --tail ${lines}${since ? ` --since ${since}` : ''}` : `journalctl -n ${lines}${since ? ` --since -${since}` : ''}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-6xl flex-col rounded-xl border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="mr-auto flex flex-col">
            <span className="text-sm font-semibold">{target.name}</span>
            <span className="font-mono text-[11px] text-muted">{cmd}</span>
          </div>
          <select value={lines} onChange={(e) => setLines(Number(e.target.value) as NonNullable<LogOptions['lines']>)}>
            {LINES.map((n) => (
              <option key={n} value={n}>
                {t('logs.lines', { n })}
              </option>
            ))}
          </select>
          <select value={since} onChange={(e) => setSince(e.target.value as LogOptions['since'] | '')}>
            {SINCE.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? t(`logs.since.${s}`) : t('logs.sinceAll')}
              </option>
            ))}
          </select>
          <input className="w-44" placeholder={t('logs.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="flex items-center gap-1 text-[12px] text-ink-2" title={t('logs.autoHint')}>
            <input type="checkbox" checked={autoSince !== null} onChange={(e) => setAutoSince(e.target.checked ? Date.now() : null)} />
            {t('logs.auto')}
          </label>
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? t('logs.reading') : t('common.refresh')}
          </Button>
          <Button onClick={() => void save()} disabled={!res?.lines}>
            {t('logs.save')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        {res?.error ? (
          <div className="p-3">
            <Alert kind="error">{res.error}</Alert>
          </div>
        ) : null}
        {saved ? (
          <div className="px-3 pt-3">
            <Alert kind="ok">{t('logs.saved', { p: saved })}</Alert>
          </div>
        ) : null}
        <pre
          ref={preRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="tnum m-0 flex-1 overflow-auto p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2"
        >
          {shown.map((l, i) => (
            <div key={i} className={/\b(error|err|fatal|exception|fail(ed)?|panic|crit)\b/i.test(l) ? 'text-critical' : /\bwarn(ing)?\b/i.test(l) ? 'text-warning' : ''}>
              {l || ' '}
            </div>
          ))}
        </pre>
        {filter ? <div className="border-t border-line px-4 py-1.5 text-[11px] text-muted">{t('logs.matches', { n: shown.length, total: all.length })}</div> : null}
      </div>
    </div>
  )
}
