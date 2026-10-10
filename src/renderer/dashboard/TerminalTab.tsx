import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { Alert, Button } from '../components/ui'

type Status = 'connecting' | 'open' | 'closed' | 'error'

/**
 * Sunucuya etkileşimli SSH terminali (xterm.js). Oturum id'si burada üretilir ki main'den gelen ilk çıktı
 * (MOTD vb.) eşleşsin. Sekme kapanınca oturum kapatılır.
 */
export function TerminalTab({ server }: { server: ServerConfig }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0b1220', foreground: '#d7deea', cursor: '#7aa2f7' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    const id = crypto.randomUUID()
    let open = false
    setStatus('connecting')
    setError(null)
    const off = api.onTerm((ev) => {
      if (ev.id !== id) return
      if (ev.data) term.write(ev.data)
      if (ev.exit) {
        open = false
        setStatus('closed')
        term.write(`\r\n\x1b[90m[${t('term.ended')}]\x1b[0m\r\n`)
      }
    })
    void api.invoke('term:open', server.id, id, term.cols, term.rows).then((r) => {
      if (!r.ok) {
        setStatus('error')
        setError(r.error ?? t('common.error'))
        return
      }
      open = true
      setStatus('open')
      term.focus()
    })
    const input = term.onData((d) => {
      if (open) void api.invoke('term:write', id, d)
    })
    const ro = new ResizeObserver(() => {
      fit.fit()
      if (open) void api.invoke('term:resize', id, term.cols, term.rows)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      input.dispose()
      off()
      void api.invoke('term:close', id)
      term.dispose()
    }
  }, [server.id, attempt])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px] text-ink-2">
        <span>
          {server.username}@{server.host} · {t(`term.status.${status}`)}
        </span>
        {status === 'closed' || status === 'error' ? (
          <Button small onClick={() => setAttempt((x) => x + 1)}>
            {t('term.reconnect')}
          </Button>
        ) : null}
        <span className="ml-auto text-muted">{t('term.hint')}</span>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div ref={ref} className="h-[60vh] overflow-hidden rounded-lg border border-line bg-[#0b1220] p-2" />
    </div>
  )
}
