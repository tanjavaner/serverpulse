// Tanıtım görselleri metinleri (TR/EN). Şablonlar ?lang=tr|en ile okur.
// Telegram balonu metni src/shared/i18n sum.* çevirileriyle ve notify/summary.ts biçimiyle aynıdır.
window.CONTENT = {
  tr: {
    site: 'tanjavaner.github.io/serverpulse',
    repo: 'github.com/tanjavaner/serverpulse',
    swipe: 'Kaydır',
    slides: [
      { kind: 'cover', title: "VDS'lerini SSH ile izle,", accent: 'sunucuya hiçbir şey kurmadan.', sub: 'ServerPulse: açık kaynak masaüstü izleme uygulaması', shot: 'dashboard.png' },
      { kind: 'problem', title: 'Her sabah aynı komutlar', accent: 'Hepsini tek pencerede topladım.', lines: ['ssh deploy@vps', 'docker ps -a', 'df -h && df -i', 'journalctl -u ssh --since "24 hours ago"', 'ss -tln', 'systemctl --failed'] },
      { kind: 'how', title: 'Agentless: sunucuda ajan yok', steps: [['Bilgisayarın', 'ServerPulse'], ['SSH', 'sabit, salt okunur komutlar'], ['Sunucun', 'hiçbir şey kurulmaz']], points: ['Komutlar beyaz listeden gelir', 'Çıktı kendi bilgisayarında ayrıştırılır', 'Sunucuda kalıcı süreç kalmaz', 'İlk host key onayla, değişirse bağlantı durur'] },
      { kind: 'shot', title: 'Tek bakışta sunucu sağlığı', sub: 'CPU, RAM, disk, ağ trafiği ve 30 güne kadar geçmiş', shot: 'dashboard.png', chips: ['CPU · RAM · Disk', 'Ağ trafiği', '30 gün geçmiş', 'Uptime %'] },
      { kind: 'shot', title: 'Projeler ve container’lar', sub: 'Docker, HTTP kontrolleri, PostgreSQL ve tek tıkla güncelleme', shot: 'project.png', chips: ['Docker', 'HTTP + SSL', 'PostgreSQL', 'compose pull && up -d'] },
      { kind: 'shot', title: 'Güvenlik gözün açık kalsın', sub: 'Başarısız SSH girişleri, yeni açılan portlar, sshd ayarları', shot: 'security.png', chips: ['SSH saldırıları', 'Yeni port alarmı', 'fail2ban', 'sshd önerileri'] },
      { kind: 'alerts', title: 'Sorun çıkınca haberin olsun', sub: 'Masaüstü bildirimi, Telegram ve webhook', shot: 'widget.png', chat: { cmd: '/durum', lines: ['📊 ServerPulse · 11.10 09:00', '', '🟠 prod-vps — CPU %40 · RAM %49 · Disk %40 · 8/8 container', '', '⚠ Açık sorunlar (1):', '🟠 prod-vps: inode / %90', '', '🔒 En yakın SSL bitişi: www.example.com — 41 gün'] } },
      { kind: 'close', title: 'Açık kaynak · MIT', sub: 'Windows kurulumu GitHub Releases’ta. Deneyin, yıldız verin, katkı yapın.', chips: ['Electron', 'TypeScript', 'React', 'ssh2', 'Türkçe + English'] }
    ]
  },
  en: {
    site: 'tanjavaner.github.io/serverpulse',
    repo: 'github.com/tanjavaner/serverpulse',
    swipe: 'Swipe',
    slides: [
      { kind: 'cover', title: 'Monitor your VPS over SSH,', accent: 'with nothing installed on the server.', sub: 'ServerPulse: an open-source desktop monitor', shot: 'dashboard.png' },
      { kind: 'problem', title: 'The same commands every morning', accent: 'Now they live in one window.', lines: ['ssh deploy@vps', 'docker ps -a', 'df -h && df -i', 'journalctl -u ssh --since "24 hours ago"', 'ss -tln', 'systemctl --failed'] },
      { kind: 'how', title: 'Agentless: no agent on the server', steps: [['Your computer', 'ServerPulse'], ['SSH', 'fixed, read-only commands'], ['Your server', 'nothing installed']], points: ['Commands come from a whitelist', 'Output is parsed on your own computer', 'No long-running process is left behind', 'Host key confirmed once; a change stops the connection'] },
      { kind: 'shot', title: 'Server health at a glance', sub: 'CPU, RAM, disk, network traffic and up to 30 days of history', shot: 'dashboard.png', chips: ['CPU · RAM · Disk', 'Network traffic', '30-day history', 'Uptime %'] },
      { kind: 'shot', title: 'Projects and containers', sub: 'Docker, HTTP checks, PostgreSQL and one-click updates', shot: 'project.png', chips: ['Docker', 'HTTP + SSL', 'PostgreSQL', 'compose pull && up -d'] },
      { kind: 'shot', title: 'Keep an eye on security', sub: 'Failed SSH logins, newly opened ports, sshd settings', shot: 'security.png', chips: ['SSH attacks', 'New-port alert', 'fail2ban', 'sshd advice'] },
      { kind: 'alerts', title: 'Know when something breaks', sub: 'Desktop notifications, Telegram and webhooks', shot: 'widget.png', chat: { cmd: '/status', lines: ['📊 ServerPulse · 10/11 09:00', '', '🟠 prod-vps — CPU 40% · RAM 49% · Disk 40% · 8/8 containers', '', '⚠ Open issues (1):', '🟠 prod-vps: inodes / 90%', '', '🔒 Nearest SSL expiry: www.example.com — 41 days'] } },
      { kind: 'close', title: 'Open source · MIT', sub: 'Windows installer on GitHub Releases. Try it, star it, contribute.', chips: ['Electron', 'TypeScript', 'React', 'ssh2', 'English + Türkçe'] }
    ]
  },
  social: {
    tr: { title: 'ServerPulse', sub: "VDS'lerini SSH ile izle, sunucuya hiçbir şey kurmadan.", chips: ['Docker', 'systemd', 'HTTP', 'PostgreSQL', 'Güvenlik'], foot: 'Açık kaynak · MIT' },
    en: { title: 'ServerPulse', sub: 'Monitor your VPS over SSH, with nothing installed on the server.', chips: ['Docker', 'systemd', 'HTTP', 'PostgreSQL', 'Security'], foot: 'Open source · MIT' }
  }
}
