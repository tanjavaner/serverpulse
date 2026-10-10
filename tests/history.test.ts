import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BUCKET_MS, HistoryStore } from '../src/main/store/history'
import type { HostMetrics } from '../src/shared/types'

const dbFile = (): string => join(mkdtempSync(join(tmpdir(), 'sp-hist-')), 'history.sqlite')
const T0 = Date.UTC(2026, 9, 1, 0, 0)
const host = (ts: number, cpu: number, rx: number | null = 100): HostMetrics => ({
  ts, cpuPct: cpu, cores: 2, load: [1, 1, 1], memTotal: 1, memUsed: 0.5, memPct: 50, swapTotal: 0, swapUsed: 0, uptimeSec: 1,
  disks: [{ fs: 'd', mount: '/', size: 10, used: 5, avail: 5, pct: 50 }], memHighSince: null, netRx: rx, netTx: 10
})

describe('geçmiş deposu', () => {
  it('eski şemalı veritabanına yeni sütunları ekler, eski kayıtlar okunur', () => {
    const file = dbFile()
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE host_samples (server_id TEXT NOT NULL, ts INTEGER NOT NULL, cpu REAL, mem REAL, disk REAL, load1 REAL);
              CREATE TABLE http_samples (check_id TEXT NOT NULL, ts INTEGER NOT NULL, status INTEGER, ms INTEGER);
              INSERT INTO http_samples VALUES ('h1', ${T0}, 200, 50), ('h1', ${T0 + 1000}, 502, 50);`)
    old.close()
    const h = new HistoryStore(file)
    h.addHost('s1', host(T0, 10))
    expect(h.hostSamples('s1', 0)).toEqual([expect.objectContaining({ cpu: 10, rx: 100, tx: 10 })])
    // ok sütunu olmayan eski kayıtlarda 5xx başarısız sayılır
    expect(h.uptime(['h1'], T0 + 2000).h1.d1).toBe(50)
    h.close()
  })

  it('5 dakikalık özet: ortalama/maksimum, içinde bulunulan dilim atlanır, tekrar çalıştırmak güvenli', () => {
    const h = new HistoryStore(dbFile())
    h.addHost('s1', host(T0, 10))
    h.addHost('s1', host(T0 + 60_000, 30))
    h.addHost('s1', host(T0 + BUCKET_MS + 1000, 90)) // ikinci dilim (içinde bulunulan)
    h.rollup(T0 + BUCKET_MS + 2000)
    h.rollup(T0 + BUCKET_MS + 2000)
    expect(h.hostRollup('s1', 0)).toEqual([expect.objectContaining({ ts: T0, cpu: 20, rx: 100 })])
    h.close()
  })

  it('uptime: özetlenmiş dilimler + henüz özetlenmemiş ham örnekler; ham silinse de korunur', () => {
    const h = new HistoryStore(dbFile())
    for (let i = 0; i < 10; i++) h.addHttp('h1', T0 + i * 30_000, i < 9 ? 200 : 503, 40, i < 9)
    h.purge(1, T0 + 3 * 3600_000) // özetler, sonra 1 saatten eski ham kayıtları siler
    expect(h.httpSamples(['h1'], 0)).toEqual([])
    h.addHttp('h1', T0 + 3 * 3600_000, 200, 40, true)
    const u = h.uptime(['h1', 'none'], T0 + 3 * 3600_000 + 1000)
    expect(u.h1).toEqual({ d1: 90.91, d7: 90.91, d30: 90.91 })
    expect(u.none).toEqual({ d1: null, d7: null, d30: null })
    h.close()
  })

  it('ok=false (ör. beklenmeyen durum kodu) kaydı başarısız sayılır', () => {
    const h = new HistoryStore(dbFile())
    h.addHttp('h1', T0, 404, 30, false)
    h.addHttp('h1', T0 + 1, 200, 30, true)
    expect(h.uptime(['h1'], T0 + 10).h1.d1).toBe(50)
    h.close()
  })
})
