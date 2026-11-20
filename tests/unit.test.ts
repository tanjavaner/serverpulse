import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t } from '../src/shared/i18n'
import type { ServerConfig, ServerState, UnitAction } from '../src/shared/types'
import { Monitor, emptyState } from '../src/main/monitor'
import { diagnoseUnit, unitAction } from '../src/main/operations'

const server: ServerConfig = {
  id: 's1', name: 'Local', host: '127.0.0.1', port: 1, username: 'deploy', authType: 'key',
  systemdUnits: ['nginx'], asterisk: false, prometheus: false, enabled: false
}

describe('unit authorization', () => {
  it('allows diagnosis independently of actions, rejects unknown units, and respects cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serverpulse-units-'))
    const monitor = new Monitor(dir)
    try {
      monitor.config.upsertServer(server)
      // Seed collected state without starting collectors or opening a network connection.
      const states = (monitor as unknown as { states: Map<string, ServerState> }).states
      const state = emptyState('s1')
      state.systemd = { ts: 0, units: [], failed: ['certbot.service', 'worker@tenant.service'] }
      states.set('s1', state)
      expect(await diagnoseUnit(monitor, 's1', 'unknown.service')).toMatchObject({ ok: false, error: t('err.unknownUnit') })
      expect(await diagnoseUnit(monitor, 's1', 'bad;unit')).toMatchObject({ ok: false, output: '', hints: [] })
      for (const unit of ['nginx', 'certbot.service', 'worker@tenant.service']) {
        // Recognized names reach the credentials gate even with allowActions disabled.
        expect(await diagnoseUnit(monitor, 's1', unit)).toMatchObject({ ok: false, error: t('err.noCreds') })
      }
      let confirmations = 0
      const cancel = async (): Promise<boolean> => { confirmations++; return false }
      expect(await unitAction(monitor, 's1', 'certbot.service', 'restart', cancel)).toMatchObject({ ok: false, error: t('err.actionsDisabled') })
      expect(confirmations).toBe(0)
      monitor.config.updateSettings({ allowActions: true })
      expect(await unitAction(monitor, 's1', 'unknown', 'restart', cancel)).toMatchObject({ ok: false, error: t('err.unknownUnit') })
      expect(await unitAction(monitor, 's1', 'certbot.service', 'bad' as UnitAction, cancel)).toMatchObject({ ok: false, error: t('err.badAction') })
      expect(confirmations).toBe(0)
      expect(await unitAction(monitor, 's1', 'certbot.service', 'restart', cancel)).toEqual({ ok: false, cancelled: true })
      expect(await unitAction(monitor, 's1', 'worker@tenant.service', 'reset-failed', cancel)).toEqual({ ok: false, cancelled: true })
      expect(confirmations).toBe(2)
    } finally {
      monitor.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts only the chosen currently listening port and deduplicates the baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serverpulse-ports-'))
    const monitor = new Monitor(dir)
    try {
      monitor.config.upsertServer({ ...server, portBaseline: ['0.0.0.0:22'] })
      const state = emptyState('s1')
      state.security = {
        ts: 0, auth: { readable: true, attempts: 0, topIps: [] },
        sshd: { passwordAuth: false, rootLogin: 'no', fromDefaults: false }, fail2ban: 'active', unattended: 'active',
        ports: ['0.0.0.0:22', '0.0.0.0:80', '0.0.0.0:443', 'x'.repeat(100), 'x'.repeat(101)]
      }
      ;(monitor as unknown as { states: Map<string, ServerState> }).states.set('s1', state)
      monitor.acceptPort('s1', '0.0.0.0:80')
      monitor.acceptPort('s1', '0.0.0.0:80')
      expect(monitor.config.server('s1')?.portBaseline).toEqual(['0.0.0.0:22', '0.0.0.0:80'])
      expect(() => monitor.acceptPort('s1', '0.0.0.0:9999')).toThrow()
      expect(() => monitor.acceptPort('s1', 'x'.repeat(101))).toThrow()
      expect(() => monitor.acceptPort('s1', 80 as unknown as string)).toThrow()
      expect(() => monitor.acceptPort('missing', '0.0.0.0:80')).toThrow()
      monitor.acceptPort('s1', 'x'.repeat(100))
      expect(monitor.config.server('s1')?.portBaseline).toContain('x'.repeat(100))
      expect(monitor.config.server('s1')?.portBaseline).not.toContain('0.0.0.0:443')
    } finally {
      monitor.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
