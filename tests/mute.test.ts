import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMuted, mutedUntil, mutePresets, serverMuteKey } from '../src/shared/mute'
import { Monitor } from '../src/main/monitor'
import { ConfigStore } from '../src/main/store/config'
import type { Issue, ServerConfig } from '../src/shared/types'

const NOW = 1_000_000

describe('sessize alma kuralları', () => {
  it('tam anahtar ve sunucu öneki eşleşir; süresi dolan geçersizdir', () => {
    const mutes = { 's1:': NOW + 1000, 's2:disk:/': NOW + 500, 's3:ram': NOW - 1 }
    expect(isMuted('s1:ctr:web:state', mutes, NOW)).toBe(true)
    expect(isMuted('s2:disk:/', mutes, NOW)).toBe(true)
    expect(isMuted('s2:disk:/var', mutes, NOW)).toBe(false)
    expect(isMuted('s3:ram', mutes, NOW)).toBe(false)
    // "s1" öneki "s10" sunucusunu kapsamaz (anahtar ":" ile biter)
    expect(isMuted('s10:ram', mutes, NOW)).toBe(false)
    expect(mutedUntil('s1:x', { 's1:': NOW + 10, 's1:x': NOW + 50 }, NOW)).toBe(NOW + 50)
    expect(serverMuteKey('abc')).toBe('abc:')
  })

  it('hazır süreler: 1 sa, 4 sa, yarın 09:00', () => {
    const now = new Date(2026, 9, 8, 22, 15)
    const [h1, h4, tomorrow] = mutePresets(now)
    expect(h1.until - now.getTime()).toBe(3600_000)
    expect(h4.until - now.getTime()).toBe(4 * 3600_000)
    expect(new Date(tomorrow.until)).toEqual(new Date(2026, 9, 9, 9, 0))
  })
})

describe('Monitor sessize alma', () => {
  let m: Monitor | null = null
  afterEach(() => m?.stop())

  it('sessizdeki sorun bildirim üretmez ama geçmişe yazılır; süre en fazla 30 gün', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-mute-'))
    m = new Monitor(dir)
    const server: ServerConfig = {
      id: 's1', name: 'VDS', host: '127.0.0.1', port: 1, username: 'deploy', authType: 'key',
      hostKeyFingerprint: 'SHA256:x', systemdUnits: [], asterisk: false, prometheus: false, enabled: true
    }
    m.config.upsertServer(server)
    m.saveSettings({ thresholds: { ...m.config.settings.thresholds, debounceSec: 0 } })
    m.start()
    const internals = m as unknown as { evaluate: () => void; scheduler: { stopAll: () => void } }
    internals.scheduler.stopAll()
    const alerts: Issue[] = []
    m.on('alert', (i: Issue) => alerts.push(i))

    m.mute('s1:', Date.now() + 365 * 24 * 3600_000)
    const until = m.snapshot().mutes['s1:']
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 24 * 3600_000)
    expect(new ConfigStore(dir).activeMutes()['s1:']).toBe(until)

    m.state('s1')!.reach = { ts: 0, tcpOk: true, tcpMs: 1, sshOk: false, sshMs: null, consecutiveFailures: 5 }
    internals.evaluate()
    expect(m.issues().map((i) => i.key)).toEqual(['s1:unreachable'])
    expect(alerts).toEqual([])
    expect(m.history.events(10).map((e) => e.key)).toEqual(['s1:unreachable'])

    expect(() => m!.mute('s1:', Date.now() - 1)).toThrow()
    m.unmute('s1:')
    expect(m.snapshot().mutes).toEqual({})
  })
})
