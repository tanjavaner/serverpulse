/**
 * Sunucuda çalıştırılabilen TÜM komutlar bu dosyada tanımlıdır (whitelist).
 * Kullanıcı girdisi komuta asla serbest metin olarak girmez: container/unit/kullanıcı adları
 * SAFE_NAME ile, IP/port/path değerleri kendi desenleriyle doğrulanır. Doğrulanamayan değer hata fırlatır.
 * Hiçbir komut sunucuda kalıcı süreç bırakmaz: -f/--follow yok, loglar --tail/-n ile sınırlı.
 * Tek istisna onaylı bakım işi maintUpgradeStart: apt, bağlantı koparsa yarıda kalmasın diye oturumdan bağımsız çalışır ve biter.
 */

import { t } from '@shared/i18n'
import { KEYWORD_RE } from '@shared/http'
import type { LogOptions } from '@shared/types'

export const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/
/** Sunucudaki ~/backups altındaki yedek dosya adları: uygulama üretir (pg-…) ya da geri yükleme için yükler (restore-…). */
export const BACKUP_FILE = /^(pg|restore)-\d{4}-\d{2}-\d{2}_\d{4,6}\.sql\.gz$/
const JOB_TS = /^\d{8}-\d{6}$/
const SAFE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const SAFE_PATH = /^\/[A-Za-z0-9_\-./?=&%~+:]*$/

export class UnsafeInputError extends Error {}

export function safeName(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !SAFE_NAME.test(value)) {
    throw new UnsafeInputError(t('err.badName', { v: JSON.stringify(value) }))
  }
  return value
}

export function safeIp(value: string): string {
  const m = SAFE_IPV4.exec(value)
  if (!m || m.slice(1).some((p) => Number(p) > 255)) throw new UnsafeInputError(t('err.badIp', { v: value }))
  return value
}

export function safePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new UnsafeInputError(t('err.badPort', { v: value }))
  return value
}

export function safeUrlPath(value: string | undefined): string {
  const v = value && value.length > 0 ? value : '/'
  if (v.length > 256 || !SAFE_PATH.test(v)) throw new UnsafeInputError(t('err.badPath', { v }))
  return v
}

export function safeBackupFile(value: string): string {
  if (typeof value !== 'string' || !BACKUP_FILE.test(value)) throw new UnsafeInputError(t('err.badBackupFile', { v: value }))
  return value
}

export function safeJobTs(value: string): string {
  if (typeof value !== 'string' || !JOB_TS.test(value)) throw new UnsafeInputError(t('err.badJobId', { v: value }))
  return value
}

const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
/** Mutlak yol; boşluk, tırnak, $ vb. içeremez, ".." bileşeni yasak. */
const ABS_PATH_RE = /^\/[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*\/?$/

export function safeComposeProject(value: string): string {
  if (typeof value !== 'string' || !COMPOSE_PROJECT_RE.test(value)) throw new UnsafeInputError(t('err.badName', { v: JSON.stringify(value) }))
  return value
}

export function safeAbsPath(value: string): string {
  if (typeof value !== 'string' || !ABS_PATH_RE.test(value) || value.split('/').includes('..')) throw new UnsafeInputError(t('err.badPath', { v: value }))
  return value
}

/** Log okuma seçenekleri yalnızca bu beyaz listeden gelebilir; takip (-f) hiçbir zaman yok. */
export const LOG_LINES = [200, 1000, 5000] as const
export const LOG_SINCE = ['15m', '1h', '24h'] as const
const JOURNAL_SINCE: Record<(typeof LOG_SINCE)[number], string> = { '15m': '15 min ago', '1h': '1 hour ago', '24h': '24 hours ago' }

function safeLogOptions(o: LogOptions): { lines: number; since?: (typeof LOG_SINCE)[number] } {
  const lines = o.lines ?? 200
  if (!(LOG_LINES as readonly number[]).includes(lines)) throw new UnsafeInputError(t('err.badLogOption', { v: lines }))
  if (o.since !== undefined && !(LOG_SINCE as readonly string[]).includes(o.since)) throw new UnsafeInputError(t('err.badLogOption', { v: o.since }))
  return { lines, since: o.since }
}

export type JobKind = 'upgrade' | 'deploy'

/**
 * Uzun bir işi SSH oturumundan bağımsız (setsid -f nohup) başlatır; bağlantı koparsa yarıda kalmaz.
 * setsid -f hemen fork eder, böylece exec kanalı işin bitmesini beklemeden kapanır.
 * Çıktı ~/serverpulse-maint/<tür>-<ts>.log, çıkış kodu .rc dosyasına yazılır. inner tek tırnak içermemeli;
 * alt kabukta çalışır ki içindeki "exit" .rc yazılmasını engellemesin.
 */
function jobStart(kind: JobKind, ts: string, inner: string): string {
  const job = safeJobTs(ts)
  if (inner.includes("'")) throw new UnsafeInputError(t('err.badSection', { v: kind }))
  const base = `"$HOME/serverpulse-maint/${kind}-${job}`
  return (
    `mkdir -p "$HOME/serverpulse-maint" && rm -f ${base}.rc" && ` +
    `{ setsid -f nohup bash -o pipefail -c '( ${inner} ); echo $? > ${base}.rc"' > ${base}.log" 2>&1 < /dev/null && echo started; }`
  )
}

/** Çıktı: "@@RC <kod|boş>", "@@SIZE <bayt>", ardından offset'ten itibaren log baytları. */
function jobPoll(kind: JobKind, ts: string, offset: number): string {
  const job = safeJobTs(ts)
  const o = safeOffset(offset)
  return (
    `f="$HOME/serverpulse-maint/${kind}-${job}"; echo "@@RC $(cat "$f.rc" 2>/dev/null)"; ` +
    `s=$(stat -c %s "$f.log" 2>/dev/null || echo 0); echo "@@SIZE $s"; ` +
    `if [ "$s" -gt ${o} ]; then tail -c +${o + 1} "$f.log" | head -c $((s - ${o})); fi`
  )
}

export function safeKeyword(value: string): string {
  if (typeof value !== 'string' || !KEYWORD_RE.test(value)) throw new UnsafeInputError(t('err.badKeyword'))
  return value
}

function safeOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new UnsafeInputError(t('err.badOffset', { v: value }))
  return value
}

// ---------------------------------------------------------------------------
// Bölümlü betik: birden çok komutu tek exec'te çalıştırıp çıktıyı işaretleyicilerle ayırır.
// ---------------------------------------------------------------------------

/**
 * $S: root ise "env" (sudo gerekmez), değilse "sudo -n". "$S VAR=x cmd" iki durumda da ortam değişkenini aktarır;
 * boş bir önek kullanılsaydı kabuk VAR=x'i komut adı sanardı.
 */
const AS_ROOT = 'if [ "$(id -u)" -eq 0 ]; then S=env; else S="sudo -n"; fi'

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
    if (!SECTION_NAME.test(s.name)) throw new Error(t('err.badSection', { v: s.name }))
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
    { name: 'net', cmd: 'cat /proc/net/dev' },
    { name: 'df', cmd: 'df -P -B1 -x tmpfs -x overlay -x devtmpfs -x squashfs -x efivarfs' }
  ],

  /** withStats false: hafif modda docker stats (iki örnek alıp ~1-2 sn süren en pahalı komut) atlanır. */
  docker: (withStats = true): Section[] => [
    { name: 'ps', cmd: "docker ps -a --no-trunc --format '{{json .}}'" },
    ...(withStats ? [{ name: 'stats', cmd: "docker stats --no-stream --no-trunc --format '{{json .}}'" }] : []),
    {
      name: 'inspect',
      cmd: "docker ps -aq | xargs -r docker inspect --format '{{.Name}}|{{.RestartCount}}|{{.State.StartedAt}}'"
    }
  ],

  dockerMeta: (): Section[] => [{ name: 'df', cmd: "docker system df --format '{{json .}}'" }],

  /** inode kullanımı ve container log sürücüsü/max-size (salt okunur). */
  storage: (): Section[] => [
    { name: 'inodes', cmd: 'df -P -i -x tmpfs -x overlay -x devtmpfs -x squashfs -x efivarfs' },
    {
      name: 'logcfg',
      cmd: `docker ps -q | xargs -r docker inspect --format '{{.Name}}|{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}'`
    }
  ],

  /**
   * Güvenlik özeti (salt okunur): son 24 saatteki başarısız SSH girişleri (journal; systemd-journal grubu gerekir),
   * etkin sshd ayarları (root ise sshd -T, değilse yapılandırma dosyaları), fail2ban/unattended-upgrades ve dinlenen portlar.
   */
  security: (): Section[] => [
    {
      name: 'auth',
      cmd: `journalctl -u ssh -u sshd --since "24 hours ago" --no-pager -o cat 2>&1 | grep -E "Failed (password|publickey) for|Invalid user|not seeing messages|No journal files" | tail -n 20000`
    },
    {
      name: 'sshd',
      cmd:
        'if [ "$(id -u)" -eq 0 ] && command -v sshd >/dev/null 2>&1; then sshd -T 2>/dev/null | grep -iE "^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) "; ' +
        'else cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | grep -iE "^[[:space:]]*(PasswordAuthentication|PermitRootLogin|KbdInteractiveAuthentication)[[:space:]]"; fi; true'
    },
    { name: 'f2b', cmd: 'systemctl is-active fail2ban 2>/dev/null; true' },
    { name: 'uu', cmd: 'systemctl is-active unattended-upgrades 2>/dev/null; true' },
    { name: 'ports', cmd: 'ss -tlnH' }
  ],

  /** En çok CPU kullanan 15 süreç (isteğe bağlı, dashboard'dan). */
  processes: (): string => 'ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu 2>&1 | head -n 16',

  systemd: (units: string[]): Section[] => {
    const sections: Section[] = []
    if (units.length > 0) {
      sections.push({ name: 'active', cmd: `systemctl is-active ${units.map(safeName).join(' ')}` })
    }
    sections.push({ name: 'failed', cmd: 'systemctl --failed --no-legend --plain' })
    return sections
  },

  /**
   * Anahtar kelime varsa gövde geçici dosyaya yazılıp grep -F ile aranır (gövde PC'ye taşınmaz) ve
   * "@@KW 1|0" satırı eklenir; bölümün çıkış kodu yine curl'ünkidir.
   */
  httpLocal: (checks: { host: string; port: number; path?: string; keyword?: string }[], timeoutSec: number): Section[] =>
    checks.map((c, i) => {
      const url = `'http://${safeIp(c.host)}:${safePort(c.port)}${safeUrlPath(c.path)}'`
      const m = Math.max(1, Math.min(60, Math.round(timeoutSec)))
      if (!c.keyword) return { name: `h${i}`, cmd: `curl -s -o /dev/null -m ${m} -w '%{http_code} %{time_total}' ${url}` }
      const kw = safeKeyword(c.keyword)
      return {
        name: `h${i}`,
        cmd:
          // "exit" kullanılmaz: bölüm tek betiğin parçası, diğer bölümleri de sonlandırırdı
          `f=$(mktemp); curl -s -o "$f" -m ${m} -w '%{http_code} %{time_total}' ${url}; rc=$?; echo; ` +
          `if grep -qF -- '${kw}' "$f"; then echo "@@KW 1"; else echo "@@KW 0"; fi; rm -f "$f"; (exit $rc)`
      }
    }),

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

  containerLogs: (name: string, opts: LogOptions = {}): string => {
    const { lines, since } = safeLogOptions(opts)
    return `docker logs --tail ${lines}${since ? ` --since ${since}` : ''} --timestamps ${safeName(name)} 2>&1`
  },
  unitLogs: (unit: string, opts: LogOptions = {}): string => {
    const { lines, since } = safeLogOptions(opts)
    return `journalctl -u ${safeName(unit)} -n ${lines}${since ? ` --since "${JOURNAL_SINCE[since]}"` : ''} --no-pager 2>&1`
  },
  /**
   * Docker disk temizliği. safe: etiketsiz (dangling) image'lar + build önbelleği; images: hiçbir container'ın
   * kullanmadığı tüm image'lar. Volume ve container'lara hiçbir modda dokunulmaz.
   */
  prune: (mode: 'safe' | 'images'): string => {
    if (mode === 'safe') return 'docker image prune -f 2>&1; docker builder prune -f 2>&1; true'
    if (mode === 'images') return 'docker image prune -af 2>&1'
    throw new UnsafeInputError(t('err.badAction'))
  },

  containerAction: (name: string, action: 'start' | 'stop' | 'restart'): string => {
    if (!['start', 'stop', 'restart'].includes(action)) throw new UnsafeInputError(t('err.badAction'))
    return `docker ${action} ${safeName(name)} 2>&1`
  },

  // -------------------------------------------------------------------------
  // Bakım. Yıkıcı olanlar (upgrade/reboot/restore/prune/autoremove) sadece onaydan sonra çağrılır.
  // sudo -n: şifre sorulursa beklemek yerine hata verir. root için sudo kullanılmaz (minimal sistemlerde sudo kurulu
  // olmayabilir). Ortam değişkenleri "sudo VAR=… cmd" ile verilir: kısıtlı sudoers'ta SETENV etiketi, ALL kuralında
  // örtük izin gerekir ("sudo env …" kullanılsaydı sudoers'ta /usr/bin/env'e, yani her şeye izin vermek gerekirdi).
  // -------------------------------------------------------------------------

  /** Şifresiz sudo ile apt-get ve reboot izni var mı (sudo -l yalnızca listeler, çalıştırmaz). */
  sudoCheck: (): Section[] => [
    { name: 'sudo_apt', cmd: `if [ "$(id -u)" -eq 0 ]; then true; else sudo -n -l apt-get >/dev/null 2>&1; fi` },
    { name: 'sudo_reboot', cmd: `if [ "$(id -u)" -eq 0 ]; then true; else sudo -n -l systemctl reboot >/dev/null 2>&1; fi` }
  ],

  /** Salt okunur durum kontrolü. */
  maintStatus: (): Section[] => [
    { name: 'kernel', cmd: 'uname -r' },
    { name: 'os', cmd: '. /etc/os-release 2>/dev/null; printf "%s\\n" "${PRETTY_NAME:-$ID}"' },
    { name: 'pkg', cmd: 'if command -v apt-get >/dev/null 2>&1; then echo apt; else echo none; fi' },
    { name: 'reboot', cmd: 'if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi' },
    { name: 'reboot_pkgs', cmd: 'cat /var/run/reboot-required.pkgs 2>/dev/null; true' },
    { name: 'upgradable', cmd: 'apt list --upgradable 2>/dev/null | tail -n +2' },
    { name: 'uptime', cmd: 'uptime' },
    { name: 'df', cmd: 'df -h / | tail -n 1' },
    { name: 'ps', cmd: "docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}'" },
    { name: 'policies', cmd: "docker ps -q | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}'" },
    ...CMD.sudoCheck()
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

  /** apt update + upgrade (ayrık iş; bkz. jobStart). */
  maintUpgradeStart: (ts: string): string =>
    jobStart(
      'upgrade',
      ts,
      `${AS_ROOT}; A="$S DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o DPkg::Lock::Timeout=300"; ` +
        `$A update && $A -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade`
    ),

  maintUpgradePoll: (ts: string, offset: number): string => jobPoll('upgrade', ts, offset),

  /**
   * docker compose pull && up -d (ayrık iş). Compose v2 yoksa çıkış kodu 3.
   * Proje adı ve yollar container etiketlerinden gelir ve burada sıkı biçimde doğrulanır.
   */
  deployStart: (ts: string, spec: { project: string; dir: string; files: string[] }): string => {
    const p = safeComposeProject(spec.project)
    const dir = safeAbsPath(spec.dir)
    const files = spec.files.map((f) => `-f ${safeAbsPath(f)}`).join(' ')
    const dc = `docker compose -p ${p}${files ? ` ${files}` : ''}`
    return jobStart('deploy', ts, `docker compose version >/dev/null 2>&1 || exit 3; cd ${dir} && ${dc} pull && ${dc} up -d`)
  },

  deployPoll: (ts: string, offset: number): string => jobPoll('deploy', ts, offset),

  maintReboot: (): string => `${AS_ROOT}; $S systemctl reboot 2>&1`,

  maintPostcheck: (): Section[] => [
    { name: 'kernel', cmd: 'uname -r' },
    { name: 'reboot', cmd: 'if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi' },
    { name: 'ps', cmd: "docker ps -a --format '{{.Names}}|{{.Status}}|{{.State}}'" }
  ],

  maintAutoremove: (): string => `${AS_ROOT}; $S DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=300 autoremove 2>&1`,

  /**
   * Yüklenen yedeği psql ile geri yükler; ardından yüklenen dosyayı ve çıktı log'unu siler.
   * psql SQL hatalarında da 0 döndüğü için hatalar ayrıca raporlanır.
   * Çıktı: "@@ERR" + ilk 200 ERROR satırı, "@@TAIL" + son 50 satır (parseRestoreOutput).
   */
  maintRestore: (file: string, container: string, user: string): string => {
    const f = safeBackupFile(file)
    return (
      `bash -o pipefail -c 'L="$HOME/backups/${f}.log"; ` +
      `gunzip -c "$HOME/backups/${f}" | docker exec -i ${safeName(container)} psql -U ${safeName(user)} -d postgres > "$L" 2>&1; rc=$?; ` +
      `echo "@@ERR"; grep "ERROR:" "$L" | head -n 200; echo "@@TAIL"; tail -n 50 "$L"; ` +
      `rm -f "$HOME/backups/${f}" "$L"; exit $rc' 2>&1`
    )
  }
}
