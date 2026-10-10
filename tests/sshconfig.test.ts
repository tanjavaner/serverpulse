import { describe, expect, it } from 'vitest'
import { parseSshConfig } from '../src/main/sshconfig'
import { fx } from './helpers'

describe('~/.ssh/config', () => {
  const hosts = parseSshConfig(fx('ssh_config.txt'), '/home/me')

  it('somut Host bloklarını okur, joker ve olumsuz desenleri atlar', () => {
    expect(hosts.map((h) => h.alias)).toEqual(['vds', 'prod-vds', 'quoted', 'only-alias'])
  })

  it('aynı bloktaki birden çok alias aynı ayarları alır; ilk değer geçerlidir', () => {
    const vds = hosts.find((h) => h.alias === 'vds')
    expect(vds).toEqual({ alias: 'vds', host: '203.0.113.10', user: 'deploy', port: 2222, identityFile: '/home/me/.ssh/serverpulse' })
    expect(hosts.find((h) => h.alias === 'prod-vds')?.port).toBe(2222)
  })

  it('= sözdizimi, tırnaklı değer, %d ve ~ açılımı', () => {
    expect(hosts.find((h) => h.alias === 'quoted')).toEqual({ alias: 'quoted', host: 'quoted.example.com', user: 'admin' })
    expect(hosts.find((h) => h.alias === 'only-alias')).toEqual({ alias: 'only-alias', host: 'only-alias', identityFile: '/home/me/.ssh/id_ed25519' })
  })

  it('Match bloğundaki ayarlar önceki Host\'a sızmaz', () => {
    expect(hosts.some((h) => h.user === 'nobody' || h.user === 'ops')).toBe(false)
  })
})
