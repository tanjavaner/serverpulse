import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import { mutedUntil, mutePresets, serverMuteKey } from '@shared/mute'
import { api } from '../lib/api'
import { shortDateTime } from '../lib/format'
import { Button } from '../components/ui'

/** Sunucu başlığındaki "sessize al" seçici; sessizse bitiş zamanı ve "bildirimleri aç". */
export function ServerMute({ serverId, mutes }: { serverId: string; mutes: Record<string, number> }): ReactNode {
  const key = serverMuteKey(serverId)
  const until = mutes[key]
  if (until) {
    return (
      <Button onClick={() => void api.invoke('alerts:unmute', key)} title={t('mute.hint')}>
        {t('mute.until', { t: shortDateTime(until) })} · {t('mute.unmute')}
      </Button>
    )
  }
  return (
    <select
      value=""
      title={t('mute.hint')}
      className="text-[13px]"
      onChange={(e) => {
        const p = mutePresets().find((x) => x.id === e.target.value)
        if (p) void api.invoke('alerts:mute', key, p.until)
      }}
    >
      <option value="">{t('mute.server')}</option>
      {mutePresets().map((p) => (
        <option key={p.id} value={p.id}>
          {t(`mute.${p.id}`)}
        </option>
      ))}
    </select>
  )
}

/** Tek bir sorun satırı için küçük sessize al / aç düğmesi. */
export function IssueMute({ issueKey, mutes }: { issueKey: string; mutes: Record<string, number> }): ReactNode {
  const own = mutes[issueKey]
  const until = mutedUntil(issueKey, mutes)
  if (until) {
    // Sunucu genelinde sessizse buradan açılamaz (sunucu başlığından açılır)
    return own ? (
      <button className="shrink-0 text-[11px] text-muted hover:text-accent" title={t('mute.until', { t: shortDateTime(until) })} onClick={() => void api.invoke('alerts:unmute', issueKey)}>
        {t('mute.issueMuted')}
      </button>
    ) : (
      <span className="shrink-0 text-[11px] text-muted" title={t('mute.until', { t: shortDateTime(until) })}>
        {t('mute.issueMuted')}
      </span>
    )
  }
  return (
    <button className="shrink-0 text-[11px] text-muted hover:text-accent" title={t('mute.hint')} onClick={() => void api.invoke('alerts:mute', issueKey, Date.now() + 3600_000)}>
      {t('mute.issue')}
    </button>
  )
}
