import { useState, type ReactNode } from 'react'
import type { AppSnapshot, ProcessResult, ServerConfig } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { fmtBytes, fmtPct } from '../lib/format'
import { Alert, Button, Card, Empty, SectionTitle, StatusDot } from '../components/ui'

const isPublic = (addr: string): boolean => /^(0\.0\.0\.0|\[::\]|\*|\[\*\]):/.test(addr)

/** Güvenlik sekmesi: SSH saldırı denemeleri, sshd ayarları, koruma servisleri, dinlenen portlar. */
export function SecurityTab({ snap, server }: { snap: AppSnapshot; server: ServerConfig }): ReactNode {
  const sec = snap.states[server.id]?.security
  if (!sec) return <Empty>{t('sec.noData')}</Empty>
  const baseline = new Set(server.portBaseline ?? [])
  const newPorts = sec.ports.filter((p) => server.portBaseline && !baseline.has(p))
  const svc = (state: string): ReactNode => (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot sev={state === 'active' ? 'ok' : state === 'unknown' ? 'unknown' : 'warn'} size={12} />
      {state}
    </span>
  )

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Card className="flex flex-col gap-2">
        <SectionTitle>{t('sec.ssh')}</SectionTitle>
        <div className="text-[12px] text-ink-2">{t('sec.failed24h')}</div>
        {!sec.auth.readable ? (
          <Alert kind="warn">{t('sec.journalDenied')}</Alert>
        ) : (
          <>
            <div className="text-xl font-semibold">{sec.auth.attempts ? t('sec.attempts', { n: sec.auth.attempts }) : t('sec.noAttempts')}</div>
            {sec.auth.topIps.length ? (
              <table className="tnum w-full text-[12px]">
                <tbody>
                  {sec.auth.topIps.map((x) => (
                    <tr key={x.ip} className="border-t border-line">
                      <td className="py-1 font-mono">{x.ip}</td>
                      <td className="py-1 text-right text-ink-2">{x.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        )}
        <table className="mt-2 w-full text-[12px]">
          <tbody>
            <tr className="border-t border-line">
              <td className="py-1.5 text-ink-2">{t('sec.passwordAuth')}</td>
              <td className={`py-1.5 text-right font-medium ${sec.sshd.passwordAuth ? 'text-warning' : 'text-good'}`}>{sec.sshd.passwordAuth ? t('sec.enabled') : t('sec.disabled')}</td>
            </tr>
            <tr className="border-t border-line">
              <td className="py-1.5 text-ink-2">{t('sec.rootLogin')}</td>
              <td className={`py-1.5 text-right font-mono ${sec.sshd.rootLogin === 'yes' ? 'text-warning' : 'text-good'}`}>{sec.sshd.rootLogin}</td>
            </tr>
          </tbody>
        </table>
        {sec.sshd.passwordAuth ? <div className="text-[11px] text-muted">{t('sec.recPassword')}</div> : null}
        {sec.sshd.rootLogin === 'yes' ? <div className="text-[11px] text-muted">{t('sec.recRoot')}</div> : null}
        {sec.sshd.fromDefaults ? <div className="text-[11px] text-muted">{t('sec.defaultsNote')}</div> : null}
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionTitle>{t('sec.protection')}</SectionTitle>
        <table className="w-full text-[12px]">
          <tbody>
            <tr className="border-t border-line">
              <td className="py-1.5 text-ink-2">{t('sec.fail2ban')}</td>
              <td className="py-1.5 text-right">{svc(sec.fail2ban)}</td>
            </tr>
            <tr className="border-t border-line">
              <td className="py-1.5 text-ink-2">{t('sec.unattended')}</td>
              <td className="py-1.5 text-right">{svc(sec.unattended)}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card className="flex flex-col gap-2 lg:col-span-2">
        <SectionTitle
          right={
            newPorts.length ? (
              <Button small onClick={() => void api.invoke('security:acceptPorts', server.id)}>
                {t('sec.acceptPorts')}
              </Button>
            ) : null
          }
        >
          {t('sec.ports')} ({sec.ports.length})
        </SectionTitle>
        <div className="text-[11px] text-muted">{t('sec.portsHint')}</div>
        <div className="flex flex-wrap gap-1.5">
          {sec.ports.map((p) => {
            const fresh = newPorts.includes(p)
            return (
              <span
                key={p}
                className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${fresh ? 'border-warning text-warning' : isPublic(p) ? 'border-line text-ink' : 'border-line text-ink-2'}`}
                title={isPublic(p) ? t('sec.public') : t('sec.local')}
              >
                {p}
                {isPublic(p) ? ' 🌐' : ''}
                {fresh ? ` · ${t('sec.new')}` : ''}
              </span>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

/** İsteğe bağlı süreç listesi: yalnızca istendiğinde okunur (periyodik değil). */
export function ProcessesCard({ server }: { server: ServerConfig }): ReactNode {
  const [res, setRes] = useState<ProcessResult | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async (): Promise<void> => {
    setLoading(true)
    setRes(await api.invoke('host:processes', server.id))
    setLoading(false)
  }
  return (
    <Card>
      <SectionTitle
        right={
          <Button small onClick={() => void load()} disabled={loading}>
            {loading ? t('logs.reading') : res ? t('common.refresh') : t('proc.load')}
          </Button>
        }
      >
        {t('proc.title')}
      </SectionTitle>
      {res?.error ? <Alert kind="error">{res.error}</Alert> : null}
      {res?.processes.length ? (
        <div className="overflow-x-auto">
          <table className="tnum w-full text-[12px]">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="py-1 font-medium">PID</th>
                <th className="py-1 font-medium">{t('proc.colUser')}</th>
                <th className="py-1 text-right font-medium">CPU</th>
                <th className="py-1 text-right font-medium">RAM</th>
                <th className="py-1 text-right font-medium">RSS</th>
                <th className="py-1 text-right font-medium">{t('proc.colTime')}</th>
                <th className="py-1 pl-3 font-medium">{t('proc.colCommand')}</th>
              </tr>
            </thead>
            <tbody>
              {res.processes.map((p) => (
                <tr key={p.pid} className="border-t border-line">
                  <td className="py-1 text-ink-2">{p.pid}</td>
                  <td className="py-1">{p.user}</td>
                  <td className="py-1 text-right">{fmtPct(p.cpuPct, 1)}</td>
                  <td className="py-1 text-right">{fmtPct(p.memPct, 1)}</td>
                  <td className="py-1 text-right text-ink-2">{fmtBytes(p.rssBytes)}</td>
                  <td className="py-1 text-right text-ink-2">{p.elapsed}</td>
                  <td className="max-w-[260px] truncate py-1 pl-3 font-mono" title={p.command}>
                    {p.command}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  )
}
