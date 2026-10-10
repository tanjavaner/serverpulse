import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Monitor } from '../src/main/monitor'
import type { Issue, ServerConfig } from '../src/shared/types'

type Internals = { evaluate: () => void; netCheck: { running: boolean; at: number }; scheduler: { stopAll: () => void } }
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

const server: ServerConfig = {
  id: 's1',
  name: 'VDS',
  // Kapalı yerel port: testte ağ trafiği oluşmasın
  host: '127.0.0.1',
  port: 1,
  username: 'deploy',
  authType: 'key',
  hostKeyFingerprint: 'SHA256:x',
  systemdUnits: [],
  asterisk: false,
  prometheus: false,
  enabled: true
}

describe('çevrimdışı tespiti', () => {
  let m: Monitor | null = null
  afterEach(() => m?.stop())

  it('internet yokken sunucu alarmları donar, tek bir yerel uyarı açılır', async () => {
    m = new Monitor(mkdtempSync(join(tmpdir(), 'sp-off-')))
    m.config.upsertServer(server)
    m.saveSettings({ thresholds: { ...m.config.settings.thresholds, debounceSec: 0 } })
    m.start()
    const alerts: [Issue, string][] = []
    m.on('alert', (i: Issue, kind: string) => alerts.push([i, kind]))
    const internals = m as unknown as Internals
    // Toplayıcılar reach durumunu ezmesin; değerlendirmeyi test elle sürer
    internals.scheduler.stopAll()
    const st = m.state('s1')!
    st.reach = { ts: 0, tcpOk: false, tcpMs: null, sshOk: false, sshMs: null, consecutiveFailures: 5 }

    // 1) İnternet var: sorun sunucuda → erişilemiyor alarmı
    m.internetCheck = async () => true
    internals.evaluate()
    await flush()
    internals.evaluate()
    expect(m.issues().map((i) => i.key)).toEqual(['s1:unreachable'])

    // 2) İnternet gitti: yerel uyarı açılır, sunucu alarmı "düzeldi" sayılmaz
    m.internetCheck = async () => false
    internals.netCheck = { running: false, at: 0 }
    internals.evaluate()
    await flush()
    internals.evaluate()
    expect(m.isOffline).toBe(true)
    expect(m.issues().map((i) => i.key).sort()).toEqual(['local:offline', 's1:unreachable'])
    expect(alerts.filter(([, k]) => k === 'resolved')).toEqual([])

    // 3) Sunucuya yeniden ulaşılınca çevrimdışı durumu biter
    st.reach = { ...st.reach, tcpOk: true, sshOk: true, consecutiveFailures: 0 }
    internals.evaluate()
    expect(m.isOffline).toBe(false)
  })
})
