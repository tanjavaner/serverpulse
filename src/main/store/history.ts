import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { AlertEvent, ContainerInfo, ContainerSample, HostMetrics, HostSample, HttpSample, Issue, Uptime } from '@shared/types'

/**
 * Yerel metrik geçmişi. Yüksek frekanslı veriler (5 sn) belleğe değil, en fazla SAMPLE_EVERY_MS'de
 * bir diske yazılır; retention süresinden eski ham kayıtlar saatte bir temizlenir.
 * Ham veri silinmeden önce 5 dakikalık özetlere (rollup) indirgenir; özetler 30 gün tutulur
 * (7/30 günlük grafikler ve uptime % bunlardan hesaplanır).
 */
const SAMPLE_EVERY_MS = 30_000
export const BUCKET_MS = 5 * 60_000
export const ROLLUP_DAYS = 30
const DAY_MS = 24 * 3600_000

/** HTTP örneği başarılı mı: yeni kayıtlarda ok sütunu, eskilerde (sütun yokken yazılmış) 5xx değilse başarılı. */
const OK_EXPR = 'COALESCE(ok, CASE WHEN status IS NOT NULL AND status < 500 THEN 1 ELSE 0 END)'

export class HistoryStore {
  private db: DatabaseSync
  private lastHost = new Map<string, number>()
  private lastCtr = new Map<string, number>()
  private st: Record<string, StatementSync>

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS host_samples (
        server_id TEXT NOT NULL, ts INTEGER NOT NULL,
        cpu REAL, mem REAL, disk REAL, load1 REAL
      );
      CREATE INDEX IF NOT EXISTS ix_host ON host_samples(server_id, ts);
      CREATE TABLE IF NOT EXISTS container_samples (
        server_id TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL,
        cpu REAL, mem REAL
      );
      CREATE INDEX IF NOT EXISTS ix_ctr ON container_samples(server_id, ts);
      CREATE TABLE IF NOT EXISTS http_samples (
        check_id TEXT NOT NULL, ts INTEGER NOT NULL, status INTEGER, ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_http ON http_samples(check_id, ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        server_id TEXT NOT NULL, project_id TEXT, key TEXT NOT NULL,
        severity TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_events ON events(ts);
      CREATE TABLE IF NOT EXISTS host_rollup (
        server_id TEXT NOT NULL, ts INTEGER NOT NULL,
        cpu REAL, cpu_max REAL, mem REAL, mem_max REAL, disk REAL, load1 REAL, rx REAL, tx REAL,
        PRIMARY KEY (server_id, ts)
      );
      CREATE TABLE IF NOT EXISTS http_rollup (
        check_id TEXT NOT NULL, ts INTEGER NOT NULL, ok INTEGER NOT NULL, total INTEGER NOT NULL, ms REAL,
        PRIMARY KEY (check_id, ts)
      );
    `)
    // Önceki sürümlerden kalan veritabanları için sütun göçü
    this.addColumn('host_samples', 'rx', 'REAL')
    this.addColumn('host_samples', 'tx', 'REAL')
    this.addColumn('http_samples', 'ok', 'INTEGER')

    this.st = {
      host: this.db.prepare('INSERT INTO host_samples (server_id, ts, cpu, mem, disk, load1, rx, tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      ctr: this.db.prepare('INSERT INTO container_samples VALUES (?, ?, ?, ?, ?)'),
      http: this.db.prepare('INSERT INTO http_samples (check_id, ts, status, ms, ok) VALUES (?, ?, ?, ?, ?)'),
      event: this.db.prepare(
        'INSERT INTO events (ts, server_id, project_id, key, severity, kind, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      qHost: this.db.prepare('SELECT ts, cpu, mem, disk, load1, rx, tx FROM host_samples WHERE server_id = ? AND ts >= ? ORDER BY ts'),
      qHostRollup: this.db.prepare('SELECT ts, cpu, mem, disk, load1, rx, tx FROM host_rollup WHERE server_id = ? AND ts >= ? ORDER BY ts'),
      qCtr: this.db.prepare('SELECT ts, name, cpu, mem FROM container_samples WHERE server_id = ? AND ts >= ? ORDER BY ts'),
      qEvents: this.db.prepare(
        'SELECT id, ts, server_id AS serverId, project_id AS projectId, key, severity, kind, title, detail FROM events ORDER BY id DESC LIMIT ?'
      )
    }
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  addHost(serverId: string, m: HostMetrics): void {
    if (m.ts - (this.lastHost.get(serverId) ?? 0) < SAMPLE_EVERY_MS) return
    this.lastHost.set(serverId, m.ts)
    const disk = m.disks.find((d) => d.mount === '/') ?? m.disks[0]
    this.st.host.run(serverId, m.ts, m.cpuPct, m.memPct, disk?.pct ?? null, m.load?.[0] ?? null, m.netRx ?? null, m.netTx ?? null)
  }

  addContainers(serverId: string, ts: number, containers: ContainerInfo[]): void {
    if (ts - (this.lastCtr.get(serverId) ?? 0) < SAMPLE_EVERY_MS) return
    this.lastCtr.set(serverId, ts)
    this.db.exec('BEGIN')
    try {
      for (const c of containers) {
        if (c.state === 'running') this.st.ctr.run(serverId, ts, c.name, c.cpuPct, c.memBytes)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  addHttp(checkId: string, ts: number, status: number | null, ms: number | null, ok?: boolean): void {
    this.st.http.run(checkId, ts, status, ms, ok === undefined ? null : ok ? 1 : 0)
  }

  addEvent(issue: Issue, kind: 'open' | 'resolved', ts: number): void {
    this.st.event.run(ts, issue.serverId, issue.projectId ?? null, issue.key, issue.severity, kind, issue.title, issue.detail ?? null)
  }

  hostSamples(serverId: string, since: number): HostSample[] {
    return this.st.qHost.all(serverId, since) as unknown as HostSample[]
  }

  /** 7/30 günlük grafikler için 5 dakikalık ortalamalar (henüz özetlenmemiş son dakikalar dahil değil). */
  hostRollup(serverId: string, since: number): HostSample[] {
    return this.st.qHostRollup.all(serverId, since) as unknown as HostSample[]
  }

  containerSamples(serverId: string, since: number): ContainerSample[] {
    return this.st.qCtr.all(serverId, since) as unknown as ContainerSample[]
  }

  httpSamples(checkIds: string[], since: number): HttpSample[] {
    if (checkIds.length === 0) return []
    const ph = checkIds.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT ts, check_id AS checkId, status, ms FROM http_samples WHERE check_id IN (${ph}) AND ts >= ? ORDER BY ts`)
      .all(...checkIds, since) as unknown as HttpSample[]
  }

  /**
   * HTTP kontrolü başına son 24 saat / 7 gün / 30 gün uptime yüzdesi. Tamamlanmış 5 dakikalık özetler +
   * henüz özetlenmemiş ham örnekler birlikte sayılır; veri yoksa null.
   */
  uptime(checkIds: string[], now = Date.now()): Record<string, Uptime> {
    const out: Record<string, Uptime> = {}
    if (!checkIds.length) return out
    const rolledUntil = ((this.db.prepare('SELECT MAX(ts) AS m FROM http_rollup').get() as { m: number | null }).m ?? -BUCKET_MS) + BUCKET_MS
    const pct = (ok: number, total: number): number | null => (total > 0 ? Math.round((ok / total) * 10000) / 100 : null)
    const qRoll = this.db.prepare('SELECT COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(total), 0) AS total FROM http_rollup WHERE check_id = ? AND ts >= ?')
    const qRaw = this.db.prepare(`SELECT COALESCE(SUM(${OK_EXPR}), 0) AS ok, COUNT(*) AS total FROM http_samples WHERE check_id = ? AND ts >= ?`)
    for (const id of checkIds) {
      const span = (days: number): number | null => {
        const since = now - days * DAY_MS
        const r = qRoll.get(id, since) as { ok: number; total: number }
        const w = qRaw.get(id, Math.max(since, rolledUntil)) as { ok: number; total: number }
        return pct(r.ok + w.ok, r.total + w.total)
      }
      out[id] = { d1: span(1), d7: span(7), d30: span(30) }
    }
    return out
  }

  events(limit: number): AlertEvent[] {
    return this.st.qEvents.all(Math.max(1, Math.min(1000, limit))) as unknown as AlertEvent[]
  }

  /**
   * Tamamlanmış 5 dakikalık dilimleri özet tablolarına yazar (tekrar çalıştırmak güvenlidir).
   * Yalnızca son özetten sonraki dilimler işlenir; içinde bulunulan dilim atlanır.
   */
  rollup(now = Date.now()): void {
    const to = Math.floor(now / BUCKET_MS) * BUCKET_MS
    const next = (table: string): number => ((this.db.prepare(`SELECT MAX(ts) AS m FROM ${table}`).get() as { m: number | null }).m ?? -BUCKET_MS) + BUCKET_MS
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO host_rollup (server_id, ts, cpu, cpu_max, mem, mem_max, disk, load1, rx, tx)
           SELECT server_id, (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS b, AVG(cpu), MAX(cpu), AVG(mem), MAX(mem), AVG(disk), AVG(load1), AVG(rx), AVG(tx)
           FROM host_samples WHERE ts >= ? AND ts < ? GROUP BY server_id, b`
        )
        .run(next('host_rollup'), to)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO http_rollup (check_id, ts, ok, total, ms)
           SELECT check_id, (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS b, SUM(${OK_EXPR}), COUNT(*), AVG(ms)
           FROM http_samples WHERE ts >= ? AND ts < ? GROUP BY check_id, b`
        )
        .run(next('http_rollup'), to)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  purge(retentionHours: number, now = Date.now()): void {
    // Ham veri silinmeden önce özetlenir
    this.rollup(now)
    const cutoff = now - retentionHours * 3600_000
    for (const t of ['host_samples', 'container_samples', 'http_samples']) {
      this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff)
    }
    const rollupCutoff = now - ROLLUP_DAYS * DAY_MS
    for (const t of ['host_rollup', 'http_rollup']) {
      this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(rollupCutoff)
    }
    // Olaylar daha uzun tutulur (30 gün)
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 30 * DAY_MS)
  }

  deleteServer(serverId: string): void {
    this.db.prepare('DELETE FROM host_samples WHERE server_id = ?').run(serverId)
    this.db.prepare('DELETE FROM container_samples WHERE server_id = ?').run(serverId)
    this.db.prepare('DELETE FROM host_rollup WHERE server_id = ?').run(serverId)
  }

  close(): void {
    this.db.close()
  }
}
