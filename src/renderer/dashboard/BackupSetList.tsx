import { useState, type ReactNode } from 'react'
import type { BackupSet } from '@shared/types'
import { t } from '@shared/i18n'
import { api } from '../lib/api'
import { dateTime, fmtBytes } from '../lib/format'
import { Button } from '../components/ui'

const SHOW_DEFAULT = 10

/** Yedek setleri listesi: satıra tıklayınca dosyalar (veritabanı başına) açılır. */
export function BackupSetList({ serverId, sets }: { serverId: string; sets: BackupSet[] }): ReactNode {
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  if (!sets.length) return <div className="text-[12px] text-muted">{t('maint.noBackups')}</div>
  const shown = all ? sets : sets.slice(0, SHOW_DEFAULT)
  return (
    <div className="flex flex-col">
      {shown.map((s) => {
        const isOpen = open === s.id
        return (
          <div key={s.id} className="border-t border-line">
            <button className="flex w-full items-center gap-2 py-1.5 text-left text-[12px] hover:bg-surface-2" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)}>
              <span className="w-3 text-muted">{isOpen ? '▾' : '▸'}</span>
              <span className="tnum text-[13px] font-semibold">{dateTime(s.ts)}</span>
              {s.legacy ? <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-ink-2">{t('backups.legacy')}</span> : null}
              {s.partial ? <span className="rounded bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-white">{t('backups.partial')}</span> : null}
              <span className="ml-auto text-ink-2">{t('backups.dbCount', { n: s.files.length })}</span>
              <span className="tnum w-20 text-right">{fmtBytes(s.totalSize)}</span>
            </button>
            {isOpen ? (
              <div className="mb-2 ml-5 rounded-md bg-surface-2 p-2">
                <table className="tnum w-full text-[12px]">
                  <tbody>
                    {s.files.map((f) => (
                      <tr key={f.file}>
                        <td className="py-0.5 font-mono">{f.db}</td>
                        <td className="py-0.5 text-right text-ink-2">{fmtBytes(f.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!s.legacy ? (
                  <div className="mt-1.5">
                    <Button small variant="ghost" onClick={() => void api.invoke('maint:openBackupDir', serverId, s.id)}>
                      {t('maint.openFolder')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
      {sets.length > SHOW_DEFAULT ? (
        <button className="border-t border-line py-1.5 text-left text-[12px] text-accent" onClick={() => setAll(!all)}>
          {all ? t('backups.showLess') : t('backups.showAll', { n: sets.length })}
        </button>
      ) : null}
    </div>
  )
}
