import type { CollectorCtx, CollectorDef } from './collectors'

/**
 * Sunucu × collector başına tek bir zamanlayıcı. Aynı collector üst üste çalışmaz;
 * SSH gerektirenler bağlantı hazır değilse atlanır ve bir sonraki tura kalır.
 */
export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>()
  private running = new Set<string>()
  private servers = new Set<string>()

  constructor(
    private collectors: CollectorDef[],
    private getCtx: (serverId: string) => CollectorCtx | null,
    private onRun: (serverId: string, collector: string) => void
  ) {}

  startServer(serverId: string): void {
    this.servers.add(serverId)
    this.collectors.forEach((c, i) => this.schedule(serverId, c, 200 + i * 150))
  }

  stopServer(serverId: string): void {
    this.servers.delete(serverId)
    for (const c of this.collectors) {
      const key = `${serverId}:${c.name}`
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
    }
  }

  stopAll(): void {
    for (const id of [...this.servers]) this.stopServer(id)
  }

  /** Seçilen collector'ları hemen çalıştırır (zaten çalışıyorsa atlar). */
  runNow(serverId: string, filter: (c: CollectorDef) => boolean = () => true): void {
    if (!this.servers.has(serverId)) return
    for (const c of this.collectors) if (filter(c)) this.schedule(serverId, c, 0)
  }

  isRunning(serverId: string, name: string): boolean {
    return this.running.has(`${serverId}:${name}`)
  }

  private schedule(serverId: string, c: CollectorDef, delay: number): void {
    const key = `${serverId}:${c.name}`
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => void this.tick(serverId, c), delay)
    )
  }

  private async tick(serverId: string, c: CollectorDef): Promise<void> {
    if (!this.servers.has(serverId)) return
    const key = `${serverId}:${c.name}`
    const ctx = this.getCtx(serverId)
    if (!ctx) return
    if (!this.running.has(key) && ctx.server.enabled && c.enabled(ctx) && (!c.needsSsh || ctx.conn.isReady)) {
      this.running.add(key)
      try {
        await c.run(ctx)
        delete ctx.state.errors[c.name]
      } catch (e) {
        ctx.state.errors[c.name] = (e as Error).message
      } finally {
        this.running.delete(key)
        this.onRun(serverId, c.name)
      }
    }
    if (!this.servers.has(serverId)) return
    // Ayarlar çalışma sırasında değişmiş olabilir: aralığı her turda yeniden oku
    this.schedule(serverId, c, Math.max(1000, c.intervalMs(ctx.settings)))
  }
}
