/**
 * Sunucu hazırlık betiği: izleme kullanıcısını oluşturur, gruplara ekler, SSH anahtarını yetkilendirir ve
 * yalnızca seçilen işler için sudoers kuralı yazar. Saf fonksiyondur (UI'da canlı önizleme + testler).
 * Betik kullanıcının kendi SSH oturumuna yapıştırılır; root değilse sudo ile kendini çalıştırır.
 */

export interface SetupOptions {
  user: string
  /** authorized_keys'e eklenecek public anahtar satırı ("ssh-ed25519 AAAA… yorum"). */
  pubKey?: string
  /** docker grubu: container'ları okuyabilmek için. */
  docker: boolean
  /** systemd-journal grubu: servis loglarını okuyabilmek için. */
  journal: boolean
  /** Şifresiz sudo: apt-get (güncelleme) ve systemctl reboot. */
  maint: boolean
  /** Şifresiz sudo: üç salt okunur asterisk -rx komutu. */
  asterisk: boolean
}

/** Linux kullanıcı adı (useradd'in varsayılan kuralına yakın, kabuk açısından güvenli). */
export const SETUP_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']
/** Yorum kısmında tırnak, ters bölü ve kontrol karakteri olmamalı (betikte tek tırnak içinde yer alır). */
const PUBKEY_RE = /^(\S+) ([A-Za-z0-9+/]+={0,3})(?: ([^'"\\\x00-\x1f]{0,100}))?$/

export const ASTERISK_SUDO_CMDS = [
  '/usr/sbin/asterisk -rx core show channels count',
  '/usr/sbin/asterisk -rx pjsip show registrations',
  '/usr/sbin/asterisk -rx pjsip show endpoints'
]

export class SetupInputError extends Error {}

/** Public anahtar satırını doğrular ve tek satıra indirger; geçersizse null. */
export function normalizePubKey(raw: string): string | null {
  const line = raw.trim().replace(/\s+/g, ' ')
  const m = PUBKEY_RE.exec(line)
  if (!m || !KEY_TYPES.includes(m[1]) || m[2].length < 40) return null
  return m[3] ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${m[2]}`
}

export function sudoersLines(o: Pick<SetupOptions, 'user' | 'maint' | 'asterisk'>): string[] {
  const lines: string[] = []
  // SETENV: "sudo DEBIAN_FRONTEND=… apt-get" biçiminde ortam değişkeni verilebilsin
  if (o.maint) lines.push(`${o.user} ALL=(root) NOPASSWD:SETENV: /usr/bin/apt-get, /usr/bin/systemctl reboot, /bin/systemctl reboot`)
  if (o.asterisk) lines.push(`${o.user} ALL=(root) NOPASSWD: ${ASTERISK_SUDO_CMDS.join(', ')}`)
  return lines
}

export function buildSetupScript(o: SetupOptions): string {
  if (!SETUP_USER_RE.test(o.user) || o.user === 'root') throw new SetupInputError('user')
  const key = o.pubKey?.trim() ? normalizePubKey(o.pubKey) : undefined
  if (key === null) throw new SetupInputError('pubkey')

  const body: string[] = ['set -eu', `U=${o.user}`, 'id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"', 'G=$(id -gn "$U")']
  const group = (g: string): string =>
    `if getent group ${g} >/dev/null; then usermod -aG ${g} "$U"; else echo "UYARI/WARNING: '${g}' grubu yok / group missing"; fi`
  if (o.docker) body.push(group('docker'))
  if (o.journal) body.push(group('systemd-journal'))
  if (key) {
    body.push(
      'H=$(getent passwd "$U" | cut -d: -f6)',
      'install -d -m 700 -o "$U" -g "$G" "$H/.ssh"',
      `K='${key}'`,
      'touch "$H/.ssh/authorized_keys"',
      'grep -qxF "$K" "$H/.ssh/authorized_keys" || printf "%s\\n" "$K" >> "$H/.ssh/authorized_keys"',
      'chown "$U:$G" "$H/.ssh/authorized_keys"',
      'chmod 600 "$H/.ssh/authorized_keys"'
    )
  }
  const sudoers = sudoersLines(o)
  if (sudoers.length) {
    // Önce geçici dosyaya yazılıp visudo ile doğrulanır; bozuk kural sudo'yu kilitlemesin
    body.push(
      "cat > /etc/sudoers.d/serverpulse.tmp <<'SP_SUDOERS'",
      ...sudoers,
      'SP_SUDOERS',
      'chmod 440 /etc/sudoers.d/serverpulse.tmp',
      'visudo -cf /etc/sudoers.d/serverpulse.tmp',
      'mv /etc/sudoers.d/serverpulse.tmp /etc/sudoers.d/serverpulse'
    )
  } else {
    body.push('rm -f /etc/sudoers.d/serverpulse')
  }
  body.push('echo "ServerPulse: $U OK"', 'id "$U"')

  // root ise doğrudan, değilse sudo ile çalışır; heredoc sayesinde tek blok halinde yapıştırılabilir
  return ['$([ "$(id -u)" -eq 0 ] || echo sudo) bash <<\'SP_SETUP\'', ...body, 'SP_SETUP', ''].join('\n')
}
