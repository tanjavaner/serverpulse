import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { AlertEvent, ContainerInfo, ContainerSample, HostMetrics, HostSample, HttpSample, Issue } from '@shared/types'

/**
 * Yerel metrik geçmişi. Yüksek frekanslı veriler (5 sn) belleğe değil, en fazla SAMPLE_EVERY_MS'de
 * bir diske yazılır; retention süresinden eski kayıtlar saatte bir temizlenir.
 */
const SAMPLE_EVERY_MS = 30_000

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
    `)
    this.st = {
      host: this.db.prepare('INSERT INTO host_samples VALUES (?, ?, ?, ?, ?, ?)'),
      ctr: this.db.prepare('INSERT INTO container_samples VALUES (?, ?, ?, ?, ?)'),
      http: this.db.prepare('INSERT INTO http_samples VALUES (?, ?, ?, ?)'),
      event: this.db.prepare(
        'INSERT INTO events (ts, server_id, project_id, key, severity, kind, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      qHost: this.db.prepare('SELECT ts, cpu, mem, disk, load1 FROM host_samples WHERE server_id = ? AND ts >= ? ORDER BY ts'),
      qCtr: this.db.prepare('SELECT ts, name, cpu, mem FROM container_samples WHERE server_id = ? AND ts >= ? ORDER BY ts'),
      qEvents: this.db.prepare(
        'SELECT id, ts, server_id AS serverId, project_id AS projectId, key, severity, kind, title, detail FROM events ORDER BY id DESC LIMIT ?'
      )
    }
  }

  addHost(serverId: string, m: HostMetrics): void {
    if (m.ts - (this.lastHost.get(serverId) ?? 0) < SAMPLE_EVERY_MS) return
    this.lastHost.set(serverId, m.ts)
    const disk = m.disks.find((d) => d.mount === '/') ?? m.disks[0]
    this.st.host.run(serverId, m.ts, m.cpuPct, m.memPct, disk?.pct ?? null, m.load?.[0] ?? null)
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

  addHttp(checkId: string, ts: number, status: number | null, ms: number | null): void {
    this.st.http.run(checkId, ts, status, ms)
  }

  addEvent(issue: Issue, kind: 'open' | 'resolved', ts: number): void {
    this.st.event.run(ts, issue.serverId, issue.projectId ?? null, issue.key, issue.severity, kind, issue.title, issue.detail ?? null)
  }

  hostSamples(serverId: string, since: number): HostSample[] {
    return this.st.qHost.all(serverId, since) as unknown as HostSample[]
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

  events(limit: number): AlertEvent[] {
    return this.st.qEvents.all(Math.max(1, Math.min(1000, limit))) as unknown as AlertEvent[]
  }

  purge(retentionHours: number): void {
    const cutoff = Date.now() - retentionHours * 3600_000
    for (const t of ['host_samples', 'container_samples', 'http_samples']) {
      this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff)
    }
    // Olaylar daha uzun tutulur (30 gün)
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - 30 * 24 * 3600_000)
  }

  deleteServer(serverId: string): void {
    this.db.prepare('DELETE FROM host_samples WHERE server_id = ?').run(serverId)
    this.db.prepare('DELETE FROM container_samples WHERE server_id = ?').run(serverId)
  }

  close(): void {
    this.db.close()
  }
}
