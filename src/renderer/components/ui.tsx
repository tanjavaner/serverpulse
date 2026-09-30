import type { ReactNode } from 'react'
import type { Severity } from '@shared/types'
import { SEV_LABEL } from '../lib/health'

const SEV_VAR: Record<Severity, string> = {
  ok: 'var(--good)',
  warn: 'var(--warning)',
  crit: 'var(--critical)',
  unknown: 'var(--unknown)'
}

const SEV_ICON: Record<Severity, string> = { ok: '✓', warn: '!', crit: '✕', unknown: '?' }

export function sevColor(s: Severity): string {
  return SEV_VAR[s]
}

/** Durum noktası: renk tek başına anlam taşımasın diye içinde ikon ve title etiketi var. */
export function StatusDot({ sev, size = 14, title }: { sev: Severity; size?: number; title?: string }): ReactNode {
  return (
    <span
      role="img"
      aria-label={title ?? SEV_LABEL[sev]}
      title={title ?? SEV_LABEL[sev]}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: SEV_VAR[sev], fontSize: size * 0.62, lineHeight: 1 }}
    >
      {size >= 12 ? SEV_ICON[sev] : null}
    </span>
  )
}

export function SevBadge({ sev, label }: { sev: Severity; label: string }): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 pr-2.5 pl-1 text-xs font-medium text-ink"
      title={`${label}: ${SEV_LABEL[sev]}`}
    >
      <StatusDot sev={sev} size={14} />
      {label}
    </span>
  )
}

/** Yatay oran çubuğu (CPU/RAM/Disk). Eşik aşılınca durum rengi alır; değer metin olarak yanında. */
export function MiniBar({ label, pct, warnAt, critAt, suffix }: { label: string; pct: number | null; warnAt: number; critAt: number; suffix?: string }): ReactNode {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const color = pct == null ? 'var(--unknown)' : v >= critAt ? 'var(--critical)' : v >= warnAt ? 'var(--warning)' : 'var(--accent)'
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 shrink-0 text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: color }} />
      </div>
      <span className="tnum w-16 shrink-0 text-right text-ink-2">
        {pct == null ? '—' : `%${Math.round(pct)}`}
        {suffix ? <span className="text-muted"> {suffix}</span> : null}
      </span>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`rounded-xl border border-line bg-surface p-4 ${className}`}>{children}</div>
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  type = 'button',
  small
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  small?: boolean
}): ReactNode {
  const base = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-[13px]'}`
  const styles = {
    default: 'border border-line bg-surface-2 text-ink hover:brightness-95 dark:hover:brightness-125',
    primary: 'bg-accent text-white hover:brightness-110',
    danger: 'border border-line bg-surface-2 text-critical hover:bg-critical hover:text-white',
    ghost: 'text-ink-2 hover:bg-surface-2'
  }[variant]
  return (
    <button type={type} className={`${base} ${styles}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="text-[13px]">{label}</span>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-3">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
      <span className="text-xl font-semibold text-ink">{value}</span>
      {sub ? <span className="text-[11px] text-ink-2">{sub}</span> : null}
    </div>
  )
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }): ReactNode {
  const color = { error: 'var(--critical)', warn: 'var(--warning)', info: 'var(--accent)', ok: 'var(--good)' }[kind]
  const icon = { error: '✕', warn: '!', info: 'i', ok: '✓' }[kind]
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2.5 text-[12px] text-ink" style={{ borderLeft: `3px solid ${color}` }}>
      <span className="mt-px font-bold" style={{ color }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
      {right}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="rounded-lg border border-dashed border-line p-6 text-center text-ink-2">{children}</div>
}
