import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LogResult } from '@shared/types'
import { api } from '../lib/api'
import { Alert, Button } from '../components/ui'

export interface LogTarget {
  serverId: string
  kind: 'container' | 'unit'
  name: string
}

/** Son 200 satır; takip modu yoktur, "Yenile" ile tekrar okunur. */
export function LogViewer({ target, onClose }: { target: LogTarget; onClose: () => void }): ReactNode {
  const [res, setRes] = useState<LogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const preRef = useRef<HTMLPreElement>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setRes(await api.invoke('logs:get', target.serverId, target.kind, target.name))
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.serverId, target.kind, target.name])

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [res])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const lines = (res?.lines ?? '').split('\n').filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex h-[80vh] w-full max-w-5xl flex-col rounded-xl border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold">{target.name}</span>
            <span className="text-[11px] text-muted">{target.kind === 'container' ? 'docker logs --tail 200' : 'journalctl -n 200'}</span>
          </div>
          <input className="ml-auto w-56" placeholder="Filtrele…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? 'Okunuyor…' : '↻ Yenile'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Kapat
          </Button>
        </div>
        {res?.error ? (
          <div className="p-3">
            <Alert kind="error">{res.error}</Alert>
          </div>
        ) : null}
        <pre ref={preRef} className="tnum m-0 flex-1 overflow-auto p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {lines.map((l, i) => (
            <div key={i} className={/\b(error|err|fatal|exception|fail(ed)?|panic|crit)\b/i.test(l) ? 'text-critical' : /\bwarn(ing)?\b/i.test(l) ? 'text-warning' : ''}>
              {l || ' '}
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
