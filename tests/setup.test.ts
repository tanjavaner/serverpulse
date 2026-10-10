import { describe, expect, it } from 'vitest'
import { buildSetupScript, normalizePubKey, SetupInputError, sudoersLines } from '../src/shared/setup'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl serverpulse@pc'
const base = { user: 'deploy', docker: true, journal: true, maint: false, asterisk: false }

describe('sunucu hazırlık betiği', () => {
  it('geçersiz kullanıcı adını ve root\'u reddeder', () => {
    for (const user of ['root', 'Deploy', 'a b', 'x;id', '$(id)', '']) {
      expect(() => buildSetupScript({ ...base, user })).toThrow(SetupInputError)
    }
  })

  it('public anahtarı doğrular; tırnak/komut içeren yorumu kabul etmez', () => {
    expect(normalizePubKey(`  ${KEY}\n`)).toBe(KEY)
    expect(normalizePubKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl x'; rm -rf /")).toBeNull()
    expect(normalizePubKey('ssh-dss AAAAB3NzaC1kc3MAAACBAP1/U4EddRIpUt9KnC7s5Of2EbdSPO9EAMMeP4C2USZpRV1AIlH7WT2NWPq')).toBeNull()
    expect(normalizePubKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull()
    expect(() => buildSetupScript({ ...base, pubKey: 'not a key' })).toThrow(SetupInputError)
  })

  it('tek blok halinde yapıştırılabilir; root değilse sudo ile çalışır', () => {
    const s = buildSetupScript({ ...base, pubKey: KEY })
    expect(s.split('\n')[0]).toBe('$([ "$(id -u)" -eq 0 ] || echo sudo) bash <<\'SP_SETUP\'')
    expect(s.trimEnd().endsWith('SP_SETUP')).toBe(true)
    expect(s).toContain('usermod -aG docker "$U"')
    expect(s).toContain('usermod -aG systemd-journal "$U"')
    expect(s).toContain(`K='${KEY}'`)
    expect(s).toContain('grep -qxF "$K"')
  })

  it('sudoers yalnızca seçilen işler için yazılır ve visudo ile doğrulanır', () => {
    expect(buildSetupScript(base)).toContain('rm -f /etc/sudoers.d/serverpulse')
    const s = buildSetupScript({ ...base, maint: true, asterisk: true })
    expect(s).toContain('visudo -cf /etc/sudoers.d/serverpulse.tmp')
    expect(sudoersLines({ user: 'deploy', maint: true, asterisk: false })).toEqual([
      'deploy ALL=(root) NOPASSWD:SETENV: /usr/bin/apt-get, /usr/bin/systemctl reboot, /bin/systemctl reboot'
    ])
    // env'e izin verilmez (her komuta izin vermekle aynı olurdu)
    expect(s).not.toMatch(/\/env\b/)
  })
})
