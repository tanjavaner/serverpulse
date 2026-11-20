import { useEffect, useState, type ReactNode } from 'react'
import type { Issue, UnitAction, UnitDiagnosis } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { Alert, Button, SectionTitle } from '../components/ui'
import { cleanErr } from './ServerForm'

type Result = { kind: 'ok' | 'error'; text: string } | null

/** Sorun satırındaki düzeltme eylemleri (issue.fix'e göre): porta "Tabana ekle", unit'e teşhis/yeniden dene/hata temizle. */
export function IssueActions({ issue, allowActions }: { issue: Issue; allowActions: boolean }): ReactNode {
  const fix = issue.fix
  const [diagOpen, setDiagOpen] = useState(false)
  const [busy, setBusy] = useState<UnitAction | null>(null)
  const [result, setResult] = useState<Result>(null)
  const [accepted, setAccepted] = useState(false)
  if (!fix) return null

  if (fix.kind === 'port') {
    return (
      <button
        className="shrink-0 text-[11px] text-muted hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        disabled={accepted}
        title={t('issue.acceptPortHint')}
        onClick={() => {
          setAccepted(true)
          void api.invoke('security:acceptPort', issue.serverId, fix.port).catch(() => setAccepted(false))
        }}
      >
        {t('issue.acceptPort')}
      </button>
    )
  }

  const run = async (action: UnitAction): Promise<void> => {
    setBusy(action)
    setResult(null)
    try {
      const r = await api.invoke('unit:action', issue.serverId, fix.unit, action)
      if (r.cancelled) return
      setResult(r.ok ? { kind: 'ok', text: t('issue.actionOk', { out: tail(r.output) }) } : { kind: 'error', text: r.error ?? t('issue.actionFailed') })
    } catch (e) {
      setResult({ kind: 'error', text: cleanErr(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <span className="flex shrink-0 flex-wrap items-center gap-1">
        <Button small variant="ghost" onClick={() => setDiagOpen(true)}>
          {t('issue.diagnose')}
        </Button>
        <Button small variant="ghost" disabled={!allowActions || busy !== null} title={allowActions ? t('issue.retryHint') : t('issue.needActions')} onClick={() => void run('restart')}>
          {busy === 'restart' ? '…' : t('issue.retry')}
        </Button>
        <Button small variant="ghost" disabled={!allowActions || busy !== null} title={allowActions ? t('issue.resetHint') : t('issue.needActions')} onClick={() => void run('reset-failed')}>
          {busy === 'reset-failed' ? '…' : t('issue.reset')}
        </Button>
      </span>
      {result && !diagOpen ? (
        <div className="basis-full">
          <Alert kind={result.kind}>{result.text}</Alert>
        </div>
      ) : null}
      {diagOpen ? <UnitDiagModal issue={issue} unit={fix.unit} allowActions={allowActions} onClose={() => setDiagOpen(false)} busy={busy} result={result} run={run} /> : null}
    </>
  )
}

function tail(s: string | undefined): string {
  const lines = (s ?? '').trim().split('\n').slice(-6).join('\n')
  return lines
}

function UnitDiagModal({
  issue,
  unit,
  allowActions,
  onClose,
  busy,
  result,
  run
}: {
  issue: Issue
  unit: string
  allowActions: boolean
  onClose: () => void
  busy: UnitAction | null
  result: Result
  run: (a: UnitAction) => Promise<void>
}): ReactNode {
  const [diag, setDiag] = useState<UnitDiagnosis | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = (): void => {
    setDiag(null)
    setErr(null)
    api.invoke('unit:diagnose', issue.serverId, unit).then(setDiag).catch((e) => setErr(cleanErr(e)))
  }
  useEffect(load, [issue.serverId, unit])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button small variant="primary" disabled={!allowActions || busy !== null} title={allowActions ? t('issue.retryHint') : t('issue.needActions')} onClick={() => void run('restart').then(load)}>
        {busy === 'restart' ? '…' : t('issue.retry')}
      </Button>
      <Button small disabled={!allowActions || busy !== null} title={allowActions ? t('issue.resetHint') : t('issue.needActions')} onClick={() => void run('reset-failed').then(load)}>
        {busy === 'reset-failed' ? '…' : t('issue.reset')}
      </Button>
      {!allowActions ? <span className="text-[11px] text-muted">{t('issue.needActions')}</span> : null}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface p-4 text-ink shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-bold">{t('unitdiag.title', { unit })}</h2>
          <Button small variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {!diag && !err ? <div className="text-[13px] text-ink-2">{t('unitdiag.loading')}</div> : null}
          {err ? <Alert kind="error">{err}</Alert> : null}
          {diag && !diag.ok ? <Alert kind="error">{diag.error ?? t('issue.actionFailed')}</Alert> : null}
          {diag?.hints.length ? (
            <div className="flex flex-col gap-1.5">
              <SectionTitle>{t('unitdiag.hints')}</SectionTitle>
              {diag.hints.map((h, i) => (
                <Alert key={i} kind="info">
                  <div className="font-semibold">{h.title}</div>
                  <div>{h.detail}</div>
                </Alert>
              ))}
            </div>
          ) : null}
          {diag?.certs?.length ? (
            <div>
              <SectionTitle>{t('unitdiag.certs')}</SectionTitle>
              <table className="w-full text-[12px]">
                <tbody>
                  {diag.certs.map((c) => {
                    const bad = c.daysLeft == null || c.daysLeft <= 14
                    return (
                      <tr key={c.name} className="border-t border-line">
                        <td className="py-1 pr-2 font-medium">{c.name}</td>
                        <td className="py-1 pr-2 text-ink-2">{c.domains.join(', ')}</td>
                        <td className={`py-1 text-right whitespace-nowrap ${bad ? 'font-semibold text-critical' : ''}`}>
                          {c.daysLeft == null ? t('unitdiag.unknownExpiry') : c.daysLeft < 0 ? t('unitdiag.expired') : t('unitdiag.daysLeft', { n: c.daysLeft })}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {diag?.output ? (
            <div>
              <SectionTitle
                right={
                  <Button
                    small
                    variant="ghost"
                    onClick={() => {
                      void api.invoke('app:copy', diag.output)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? t('unitdiag.copied') : t('unitdiag.copy')}
                  </Button>
                }
              >
                {t('unitdiag.output')}
              </SectionTitle>
              <pre className="m-0 max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{diag.output}</pre>
            </div>
          ) : null}
          {result ? <Alert kind={result.kind}>{result.text}</Alert> : null}
        </div>
        {actions}
      </div>
    </div>
  )
}
