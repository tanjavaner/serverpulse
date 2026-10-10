import { useEffect, useRef, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { stepLabel, type LogLine } from '../lib/maintLog'
import { Card, SectionTitle } from '../components/ui'

/** Bakım ve deploy işlerinin canlı çıktısı; hata/başarı satırları renklendirilir. */
export function LiveLog({ lines, height = 'h-72' }: { lines: LogLine[]; height?: string }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length])
  return (
    <Card>
      <SectionTitle>{t('maint.liveOutput')}</SectionTitle>
      <pre ref={ref} className={`tnum m-0 ${height} overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2`}>
        {lines.length === 0 ? <span className="text-muted">{t('maint.noOutput')}</span> : null}
        {lines.map((l, i) => (
          <div key={i} className={/^✕|\b(E:|error|failed)\b/i.test(l.text) ? 'text-critical' : /^✓/.test(l.text) ? 'text-good' : /^(▶|═)|^W:|⚠/.test(l.text) ? 'text-ink' : ''}>
            <span className="text-muted">[{stepLabel(l.step)}] </span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </Card>
  )
}
