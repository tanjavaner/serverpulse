/**
 * Sunucuda çalıştırılabilen TÜM komutlar bu dosyada tanımlıdır (whitelist).
 * Kullanıcı girdisi komuta asla serbest metin olarak girmez: container/unit/kullanıcı adları
 * SAFE_NAME ile, IP/port/path değerleri kendi desenleriyle doğrulanır. Doğrulanamayan değer hata fırlatır.
 * Hiçbir komut sunucuda kalıcı süreç bırakmaz: -f/--follow yok, loglar --tail/-n ile sınırlı.
 * Tek istisna onaylı bakım işi maintUpgradeStart: apt, bağlantı koparsa yarıda kalmasın diye oturumdan bağımsız çalışır ve biter.
 */

export const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/
/** Sunucudaki ~/backups altındaki yedek dosya adları: uygulama üretir (pg-…) ya da geri yükleme için yükler (restore-…). */
export const BACKUP_FILE = /^(pg|restore)-\d{4}-\d{2}-\d{2}_\d{4,6}\.sql\.gz$/
const JOB_TS = /^\d{8}-\d{6}$/
const SAFE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const SAFE_PATH = /^\/[A-Za-z0-9_\-./?=&%~+:]*$/

export class UnsafeInputError extends Error {}

export function safeName(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !SAFE_NAME.test(value)) {
    throw new UnsafeInputError(`Geçersiz ad: ${JSON.stringify(value)}`)
  }
  return value
}

export function safeIp(value: string): string {
  const m = SAFE_IPV4.exec(value)
  if (!m || m.slice(1).some((p) => Number(p) > 255)) throw new UnsafeInputError(`Geçersiz IP: ${value}`)
  return value
}

export function safePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new UnsafeInputError(`Geçersiz port: ${value}`)
  return value
}

export function safeUrlPath(value: string | undefined): string {
  const v = value && value.length > 0 ? value : '/'
  if (v.length > 256 || !SAFE_PATH.test(v)) throw new UnsafeInputError(`Geçersiz path: ${v}`)
  return v
}

export function safeBackupFile(value: string): string {
  if (typeof value !== 'string' || !BACKUP_FILE.test(value)) throw new UnsafeInputError(`Geçersiz yedek dosyası: ${value}`)
  return value
}

export function safeJobTs(value: string): string {
  if (typeof value !== 'string' || !JOB_TS.test(value)) throw new UnsafeInputError(`Geçersiz iş kimliği: ${value}`)
  return value
}

function safeOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new UnsafeInputError(`Geçersiz offset: ${value}`)
  return value
}

// ---------------------------------------------------------------------------
// Bölümlü betik: birden çok komutu tek exec'te çalıştırıp çıktıyı işaretleyicilerle ayırır.
// ---------------------------------------------------------------------------

export interface Section {
  name: string
  cmd: string
}

export interface SectionOutput {
  out: string
  rc: number | null
}

const SECTION_NAME = /^[a-z0-9_]+$/

export function buildScript(sections: Section[]): string {
  const parts = sections.map((s) => {
    if (!SECTION_NAME.test(s.name)) throw new Error(`Geçersiz bölüm adı: ${s.name}`)
    return `echo '@@S ${s.name}'; { ${s.cmd} ; } 2>&1; echo "@@RC $?"`
  })
  return `export LC_ALL=C; ${parts.join('; ')}`
}

export function parseSections(stdout: string): Record<string, SectionOutput> {
  const result: Record<string, SectionOutput> = {}
  let current: string | null = null
  let buf: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const s = /^@@S ([a-z0-9_]+)$/.exec(line)
    if (s) {
      current = s[1]
      buf = []
      continue
    }
    // Komut çıktısı satır sonu olmadan bitebilir (ör. curl -w); o zaman işaretleyici satırın sonuna yapışır
    const rc = /^(.*)@@RC (\d+)$/.exec(line)
    if (rc && current) {
      if (rc[1]) buf.push(rc[1])
      result[current] = { out: buf.join('\n'), rc: Number(rc[2]) }
      current = null
      buf = []
      continue
    }
    if (current) buf.push(line)
  }
  // Zaman aşımı vb. ile yarım kalan son bölüm
  if (current) result[current] = { out: buf.join('\n'), rc: null }
  return result
}

// ---------------------------------------------------------------------------
// Komut tanımları
// ---------------------------------------------------------------------------

export const CMD = {
  host: (): Section[] => [
    { name: 'loadavg', cmd: 'cat /proc/loadavg' },
    { name: 'meminfo', cmd: 'cat /proc/meminfo' },
    { name: 'uptime', cmd: 'cat /proc/uptime' },
    { name: 'stat', cmd: 'head -1 /proc/stat' },
    { name: 'nproc', cmd: 'nproc' },
    { name: 'df', cmd: 'df -P -B1 -x tmpfs -x overlay -x devtmpfs -x squashfs -x efivarfs' }
  ],

  docker: (): Section[] => [
    { name: 'ps', cmd: "docker ps -a --no-trunc --format '{{json .}}'" },
    { name: 'stats', cmd: "docker stats --no-stream --no-trunc --format '{{json .}}'" },
    {
      name: 'inspect',
      cmd: "docker ps -aq | xargs -r docker inspect --format '{{.Name}}|{{.RestartCount}}|{{.State.StartedAt}}'"
    }
  ],

  dockerMeta: (): Section[] => [{ name: 'df', cmd: "docker system df --format '{{json .}}'" }],

  systemd: (units: string[]): Section[] => {
    const sections: Section[] = []
    if (units.length > 0) {
      sections.push({ name: 'active', cmd: `systemctl is-active ${units.map(safeName).join(' ')}` })
    }
    sections.push({ name: 'failed', cmd: 'systemctl --failed --no-legend --plain' })
    return sections
  },

  httpLocal: (checks: { host: string; port: number; path?: string }[], timeoutSec: number): Section[] =>
    checks.map((c, i) => ({
      name: `h${i}`,
      cmd: `curl -s -o /dev/null -m ${Math.max(1, Math.min(60, Math.round(timeoutSec)))} -w '%{http_code} %{time_total}' 'http://${safeIp(c.host)}:${safePort(c.port)}${safeUrlPath(c.path)}'`
    })),

  postgres: (container: string, user: string): Section[] => {
    const c = safeName(container)
    const u = safeName(user)
    return [
      { name: 'ready', cmd: `docker exec ${c} pg_isready -U ${u}` },
      { name: 'conns', cmd: `docker exec ${c} psql -U ${u} -d postgres -tAc "select count(*) from pg_stat_activity"` },
      {
        name: 'sizes',
        cmd: `docker exec ${c} psql -U ${u} -d postgres -tA -F '|' -c "select datname, pg_database_size(datname) from pg_database where not datistemplate"`
      }
    ]
  },

  /** root değilse sudo -n (şifre sormaz) ile, sudoers'ta tanımlı üç okuma komutu. */
  asterisk: (isRoot: boolean): Section[] => {
    const p = isRoot ? '' : 'sudo -n '
    return [
      { name: 'channels', cmd: `${p}/usr/sbin/asterisk -rx 'core show channels count'` },
      { name: 'registrations', cmd: `${p}/usr/sbin/asterisk -rx 'pjsip show registrations'` },
      { name: 'endpoints', cmd: `${p}/usr/sbin/asterisk -rx 'pjsip show endpoints'` }
    ]
  },

  test: (isRoot: boolean): Section[] => [
    { name: 'uname', cmd: 'uname -a' },
    { name: 'id', cmd: 'id' },
    { name: 'docker', cmd: "docker version --format '{{.Server.Version}}'" },
    { name: 'asterisk_bin', cmd: 'test -x /usr/sbin/asterisk' },
    {
      name: 'asterisk_sudo',
      cmd: isRoot ? 'true' : "sudo -n -l /usr/sbin/asterisk -rx 'core show channels count'"
    }
  ],

  discovery: (): Section[] => [
    { name: 'ps', cmd: "docker ps -a --no-trunc --format '{{json .}}'" },
    { name: 'units', cmd: 'systemctl list-units --type=service --state=running --no-legend --plain' },
    { name: 'ss', cmd: 'ss -tlnH' },
    {
      name: 'nginx',
      cmd: 'for f in /etc/nginx/sites-enabled/*; do [ -f "$f" ] && { echo "@@F $f"; head -c 200000 "$f"; echo; }; done'
    }
  ],

  pgUser: (container: string): Section[] => [
    { name: `pguser`, cmd: `docker exec ${safeName(container)} printenv POSTGRES_USER` }
  ],

  containerLogs: (name: string): string => `docker logs --tail 200 --timestamps ${safeName(name)} 2>&1`,
  unitLogs: (unit: string): string => `journalctl -u ${safeName(unit)} -n 200 --no-pager 2>&1`,
  restartContainer: (name: string): string => `docker restart ${safeName(name)} 2>&1`,

  // -------------------------------------------------------------------------
  // Bakım. Yıkıcı olanlar (upgrade/reboot/restore/prune/autoremove) sadece onaydan sonra çağrılır.
  // sudo -n: şifre sorulursa beklemek yerine hata verir.
  // -------------------------------------------------------------------------

  /** Salt okunur durum kontrolü. */
  maintStatus: (): Section[] => [
    { name: 'kernel', cmd: 'uname -r' },
    { name: 'reboot', cmd: 'if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi' },
    { name: 'reboot_pkgs', cmd: 'cat /var/run/reboot-required.pkgs 2>/dev/null; true' },
    { name: 'upgradable', cmd: 'apt list --upgradable 2>/dev/null | tail -n +2' },
    { name: 'uptime', cmd: 'uptime' },
    { name: 'df', cmd: 'df -h / | tail -n 1' },
    { name: 'ps', cmd: "docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}'" },
    { name: 'policies', cmd: "docker ps -q | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}'" },
    { name: 'sudo', cmd: 'sudo -n true' }
  ],

  /** Container ortamından POSTGRES_USER (otomatik tespit). */
  pgEnvUser: (container: string): Section[] => [
    {
      name: 'pguser',
      cmd: `docker inspect ${safeName(container)} -f '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p' | head -n 1`
    }
  ],

  /** pg_dumpall → gzip. pipefail: dump hata verirse yarım dosya başarılı sayılmaz ve silinir. */
  maintBackup: (file: string, container: string, user: string): string => {
    const f = safeBackupFile(file)
    return (
      `bash -o pipefail -c 'mkdir -p "$HOME/backups" || exit 1; ` +
      `if [ -e "$HOME/backups/${f}" ]; then echo "Dosya zaten var: ${f}"; exit 1; fi; ` +
      `docker exec ${safeName(container)} pg_dumpall -U ${safeName(user)} | gzip > "$HOME/backups/${f}" || { rm -f "$HOME/backups/${f}"; exit 1; }' 2>&1`
    )
  },

  maintBackupVerify: (file: string): Section[] => {
    const p = `"$HOME/backups/${safeBackupFile(file)}"`
    return [
      { name: 'home', cmd: 'printf "%s\\n" "$HOME"' },
      { name: 'size', cmd: `stat -c %s ${p}` },
      { name: 'gunzip_t', cmd: `gunzip -t ${p}` },
      { name: 'tail', cmd: `gunzip -c ${p} | tail -n 3` },
      { name: 'sha', cmd: `sha256sum ${p} | cut -d' ' -f1` }
    ]
  },

  /** Sunucuda son 7 pg-* yedeğini tutar. */
  maintBackupPrune: (): string => `ls -1t "$HOME"/backups/pg-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -v -- 2>&1`,

  /**
   * apt update + upgrade'i SSH oturumundan bağımsız (setsid -f nohup) başlatır; bağlantı koparsa dpkg yarıda kalmaz.
   * setsid -f hemen fork eder, böylece exec kanalı apt bitmesini beklemeden kapanır.
   * Çıktı ~/serverpulse-maint/upgrade-<ts>.log, çıkış kodu .rc dosyasına yazılır.
   */
  maintUpgradeStart: (ts: string): string => {
    const t = safeJobTs(ts)
    const apt = 'sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o DPkg::Lock::Timeout=300'
    const inner =
      `${apt} update && ${apt} -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade; ` +
      `echo $? > "$HOME/serverpulse-maint/upgrade-${t}.rc"`
    return (
      `mkdir -p "$HOME/serverpulse-maint" && rm -f "$HOME/serverpulse-maint/upgrade-${t}.rc" && ` +
      `{ setsid -f nohup bash -o pipefail -c '${inner}' > "$HOME/serverpulse-maint/upgrade-${t}.log" 2>&1 < /dev/null && echo started; }`
    )
  },

  /** Çıktı: "@@RC <kod|boş>", "@@SIZE <bayt>", ardından offset'ten itibaren log baytları. */
  maintUpgradePoll: (ts: string, offset: number): string => {
    const t = safeJobTs(ts)
    const o = safeOffset(offset)
    return (
      `f="$HOME/serverpulse-maint/upgrade-${t}"; echo "@@RC $(cat "$f.rc" 2>/dev/null)"; ` +
      `s=$(stat -c %s "$f.log" 2>/dev/null || echo 0); echo "@@SIZE $s"; ` +
      `if [ "$s" -gt ${o} ]; then tail -c +${o + 1} "$f.log" | head -c $((s - ${o})); fi`
    )
  },

  maintReboot: (): string => 'sudo -n systemctl reboot 2>&1',

  maintPostcheck: (): Section[] => [
    { name: 'kernel', cmd: 'uname -r' },
    { name: 'reboot', cmd: 'if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi' },
    { name: 'ps', cmd: "docker ps -a --format '{{.Names}}|{{.Status}}|{{.State}}'" }
  ],

  maintAutoremove: (): string =>
    'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=300 autoremove 2>&1',

  /** Yüklenen yedeği psql ile geri yükler; ardından yüklenen dosyayı siler. */
  maintRestore: (file: string, container: string, user: string): string => {
    const f = safeBackupFile(file)
    return (
      `bash -o pipefail -c 'gunzip -c "$HOME/backups/${f}" | docker exec -i ${safeName(container)} psql -U ${safeName(user)} -d postgres 2>&1 | tail -n 100; ` +
      `rc=$?; rm -f "$HOME/backups/${f}"; exit $rc' 2>&1`
    )
  }
}
