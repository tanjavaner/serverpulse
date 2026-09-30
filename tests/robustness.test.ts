import { describe, expect, it } from 'vitest'
import { fx } from './helpers'
import * as host from '../src/main/parsers/host'
import * as docker from '../src/main/parsers/docker'
import * as misc from '../src/main/parsers/misc'
import { parseSections } from '../src/main/ssh/commands'

// Parse edilemeyen çıktı uygulamayı çökertmemeli; alanlar null/boş ("bilinmiyor") dönmeli.
describe('bozuk çıktıya dayanıklılık', () => {
  const inputs = [fx('garbage.txt'), '', '\n\n', '\u0000\u0001binary', 'x'.repeat(100_000)]

  it('hiçbir parser istisna fırlatmaz', () => {
    for (const s of inputs) {
      expect(() => {
        host.parseLoadavg(s)
        host.parseMeminfo(s)
        host.parseUptime(s)
        host.parseProcStat(s)
        host.parseDf(s)
        host.parseHost(parseSections(s), null, 0)
        docker.parseDockerPs(s)
        docker.parseDockerStats(s)
        docker.parseInspectLines(s)
        docker.parseSystemDf(s)
        docker.parseLabels(s)
        docker.parsePublishedPorts(s)
        misc.parseIsActive(['nginx'], s)
        misc.parseFailedUnits(s)
        misc.parseRunningUnits(s)
        misc.parseCurl(s, 1)
        misc.parsePgIsReady(s, null)
        misc.parseSingleInt(s)
        misc.parseDbSizes(s)
        misc.parseChannelsCount(s)
        misc.parseRegistrations(s)
        misc.parseEndpoints(s)
        misc.parseSsListen(s)
        misc.parseNginxSites(s)
      }).not.toThrow()
    }
  })

  it('bozuk host çıktısı null alanlarla döner', () => {
    const { metrics } = host.parseHost(parseSections(`@@S meminfo\n${fx('garbage.txt')}\n@@RC 0`), null, 0)
    expect(metrics.memPct).toBeNull()
    expect(metrics.cpuPct).toBeNull()
    expect(metrics.load).toBeNull()
    expect(metrics.disks).toEqual([])
  })

  it('bozuk docker ps satırları atlanır', () => {
    expect(docker.parseDockerPs(fx('garbage.txt'))).toEqual([])
  })

  it('bilinmeyen unit durumu "unknown" olur', () => {
    expect(misc.parseIsActive(['nginx', 'docker'], 'active')).toEqual([
      { name: 'nginx', state: 'active' },
      { name: 'docker', state: 'unknown' }
    ])
  })
})
