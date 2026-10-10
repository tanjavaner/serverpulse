# ServerPulse

Sunucuları ve üzerindeki projeleri (Docker, systemd, .NET/TS backend'ler, PostgreSQL, Asterisk) VDS'e girmeden, kendi bilgisayarınızdan izleyen masaüstü uygulaması. Windows (x64) ve macOS (Apple Silicon) üzerinde çalışır.

**Agentless:** Sunucuya hiçbir şey kurulmaz. Uygulama SSH ile bağlanır, önceden tanımlı ve salt okunur komutları çalıştırır, çıktıyı kendi bilgisayarınızda parse eder. Sunucuda kalıcı süreç bırakılmaz; loglar yalnızca `--tail 200` / `-n 200` ile okunur, asla `-f` ile takip edilmez.

- **Widget (sağ alt):** Her sunucu için durum, CPU/RAM/Disk çubukları, "8/8 container sağlıklı", aktif çağrı sayısı ve açık sorunlar. Kırmızı durumlar en üstte gösterilir. Tıklanınca dashboard açılır.
- **Tray / menü çubuğu:** İkon rengi en kötü duruma göre değişir (yeşil, sarı, kırmızı, gri). Tıklayınca widget açılır/kapanır, sağ tık menüsünde Dashboard, Yenile ve Çıkış bulunur.
- **Dashboard:** Sunucu/proje ağacı, proje kartları (Backend/Frontend/DB/Asterisk rozetleri, HTTP yanıt süresi ve uptime %, SSL kalan gün, container CPU/RAM), 1 saatten 30 güne kadar CPU/RAM/disk ve ağ trafiği grafikleri (yerel SQLite; isteğe bağlı Prometheus), süreç listesi, güvenlik sekmesi, loglar, `docker system df`, olay geçmişi.
- **Alarmlar:** Durum değiştiğinde native bildirim gönderilir (debounce'lu). İsteğe bağlı olarak **Telegram** ve **webhook**'a da gider (Ayarlar → Harici bildirimler; token/URL işletim sistemi güvenli depolamasında şifreli saklanır).
- **Dil:** Türkçe ve İngilizce (Ayarlar → Genel → Dil). Varsayılan "Sistem": işletim sistemi Türkçeyse Türkçe, değilse İngilizce. Dil desteğinden önce kurulmuş uygulamalar Türkçe kalır. Metinler `src/shared/i18n/` altındadır; yeni metin önce `tr.ts`'e, aynı anahtarla `en.ts`'e eklenir (eksik anahtar derleme hatası verir).

## Geliştirme

```bash
npm install
npm run dev          # electron-vite, hot reload
npm test             # vitest: parser, keşif, alarm testleri
npm run typecheck
```

> `npm install` sonrasında Electron binary'si inmediyse: `node node_modules/electron/install.js`

## Paketleme

```bash
npm run icons        # build/icon.png'yi yeniden üretir (isteğe bağlı; dosya repoda)
npm run dist:win     # Windows PC'de → dist/ServerPulse-Setup-x.y.z.exe (NSIS, x64)
npm run dist:mac     # Mac'te        → dist/ServerPulse-x.y.z-arm64.dmg
```

Native bağımlılık yoktur. SQLite için Electron'un içindeki `node:sqlite` kullanılır. Bu yüzden `electron-rebuild` veya derleme araçları gerekmez. Yine de her platformun paketi kendi işletim sisteminde üretilmelidir.

- **macOS:** Paket imzasız olduğu için dmg ilk açılışta sağ tık → **Aç** ile açılmalıdır. Alternatif olarak `xattr -dr com.apple.quarantine /Applications/ServerPulse.app` çalıştırılabilir. İmzalama ve notarization için Apple Developer hesabı gerekir (opsiyonel). Uygulama bir menü çubuğu uygulaması olarak çalışır (`LSUIElement`); Dock ikonu sadece dashboard açıkken görünür.
- **Windows:** İmzasız `.exe` için SmartScreen uyarısı çıkabilir: "Ek bilgi" → "Yine de çalıştır".
- **Açılışta başlama:** Ayarlar → "Bilgisayar açılınca başlat". Sadece kurulu sürümde etkilidir.

## Sunucu tarafı hazırlık (tek seferlik, önerilir)

Uygulama root ile de çalışır, ama salt okunur izleme için ayrı bir kullanıcı önerilir. En kolayı: **Sunucu ekle → "Sunucuyu hazırla"** bölümü, formdaki kullanıcı adına göre tek blokluk bir betik üretir. Sunucuya root ya da sudo yetkili bir kullanıcıyla bağlanıp bloğu yapıştırmanız yeterli. Betik tekrar çalıştırılabilir ve şunları yapar:

- Kullanıcı yoksa oluşturur; seçime göre `docker` (container'ları okumak) ve `systemd-journal` (servis logları ve güvenlik sekmesindeki başarısız SSH girişleri) gruplarına ekler.
- Seçilen özel anahtarın public satırını (uygulama anahtardan üretir) `authorized_keys`'e bir kez ekler.
- Yalnızca seçilen işler için `/etc/sudoers.d/serverpulse` yazar ve `visudo -cf` ile doğrulamadan etkinleştirmez:
  - Bakım: `NOPASSWD:SETENV: /usr/bin/apt-get, /usr/bin/systemctl reboot` (uygulama `sudo VAR=… apt-get` kullanır; `sudo env …` gerektirmediği için `env`'e, yani her komuta izin vermek gerekmez)
  - Asterisk: üç salt okunur `asterisk -rx` komutu

Elle yapmak isterseniz:

```bash
sudo usermod -aG docker deploy
sudo usermod -aG systemd-journal deploy
ssh-keygen -t ed25519 -f ~/.ssh/serverpulse -C serverpulse   # PC'de
ssh-copy-id -i ~/.ssh/serverpulse.pub deploy@sunucu.ornek.com
```

> Not: `docker` grubu ve `apt-get` için sudo izni pratikte root yetkisine denktir. Uygulama sadece whitelist'teki komutları çalıştırır, fakat anahtarı buna göre koruyun ve yalnızca kullanacağınız izinleri verin.

Asterisk kuralı yoksa yalnızca `systemctl is-active asterisk` sonucu gösterilir. "Bağlantıyı test et" ve bakım durum kontrolü izinleri `sudo -n -l` ile denetler (çalıştırmadan listeler); izin olmayan bakım butonları kapanır.

### Giriş yöntemleri

- **Özel anahtar** (önerilir): Dosya içeriği işletim sisteminin güvenli deposunda şifreli saklanır.
- **SSH agent:** Anahtar uygulamaya hiç kopyalanmaz. Windows'ta OpenSSH agent (1Password/Bitwarden agent'ları da bu kanalı kullanır) ya da Pageant, macOS'ta `SSH_AUTH_SOCK`.
- **Şifre:** Desteklenir ama önerilmez.

Yeni sunucu eklerken `~/.ssh/config` dosyanızdaki Host blokları formun sağ üstündeki listeden seçilerek host, port, kullanıcı ve anahtar dosyası doldurulabilir (host key yine onaylanır).

### Yeni bilgisayara taşıma

**Ayarlar → Yapılandırmayı taşı:** Sunucular, projeler ve ayarlar bir JSON dosyasına aktarılır; host key onayları korunur, içe aktarırken var olan sunucular atlanır. "Şifreleri, anahtarları ve bildirim token'larını da ekle" seçilirse bunlar parolayla şifrelenir (scrypt + AES-256-GCM); seçilmezse içe aktarılan sunucular için kimlik bilgisini Düzenle'den girersiniz.

### Güvenlik önerisi (uygulama kapsamı dışında)

Birçok VDS hazır kurulumda `PasswordAuthentication yes` ve `PermitRootLogin yes` ile gelir. Uygulama anahtarla (mümkünse VPN/Tailscale gibi özel bir ağ adresi üzerinden) çalışır hale geldikten sonra `/etc/ssh/sshd_config` içinde bu iki ayarı kapatmayı düşünün. Kapatmadan önce anahtarla girişin çalıştığını ayrı bir oturumda doğrulayın.

## Kullanım

1. **Sunucu ekle:** Ad, host/IP, port, kullanıcı ve giriş yöntemi (özel anahtar, SSH agent ya da şifre) girilir. Sunucu henüz hazır değilse "Sunucuyu hazırla" betiğini kullanın.
2. **Bağlantıyı test et:** Önce host key parmak izi gösterilir. Sunucuda `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` çıktısıyla karşılaştırıp onaylayın (TOFU). Sonra `uname -a`, `id`, docker erişimi ve Asterisk sudo kuralı kontrol edilir.
3. **Kaydet ve keşfet:** `docker ps` (compose label'ları), çalışan systemd servisleri, `ss -tln` ve `/etc/nginx/sites-enabled/*` okunur. Compose `working_dir` bir proje olarak, nginx `server_name` → `proxy_pass` portu da public URL olarak önerilir. Önerileri onaylayın veya düzenleyin. Aynı üst dizindeki projeler (ör. `/opt/apps/x/backend` ve `/opt/apps/x/socket`) için "Birleştir" önerisi çıkar; istediğiniz önerileri seçip elle de tek projede birleştirebilirsiniz. Sunucu ekranındaki "Tümünü sil ve yeniden keşfet" kayıtlı projeleri silip keşfi baştan başlatır.
4. Proje ekranında **Düzenle** ile health path'leri, container rollerini, Postgres kullanıcısını vb. ayarlayın.

### Sunucu bakımı (Bakım sekmesi)

Durum kontrolü (çekirdek, reboot gerekli mi, bekleyen/güvenlik güncellemeleri, restart politikası `no` olan container'lar) her zaman çalışır. Diğer işlemler **Ayarlar → Yönetim eylemleri** açıkken ve native onayla çalışır; sudo'nun şifresiz (`sudo -n`) çalışması gerekir. Paket güncelleme ve autoremove yalnızca **Debian/Ubuntu (apt)** sistemlerde desteklenir; diğer dağıtımlarda durum kontrolü bunu belirtir ve ilgili butonlar kapanır.

- **Postgres yedeği:** `pg_dumpall | gzip` (`pipefail`), `gunzip -t` + "dump complete" + sha256 doğrulaması, SFTP ile `backups/<sunucu-id>/` altına indirme; sunucuda son 7 yedek tutulur. Container/kullanıcı sunucu ayarlarından ya da otomatik tespit edilir.
- **Güncelleme:** `apt-get update && upgrade` sunucuda oturumdan bağımsız çalışır (`~/serverpulse-maint/upgrade-*.log`), çıktı canlı akar. Son 24 saatte yedek yoksa önce yedek önerilir.
- **Reboot:** `REBOOT` yazdırma + native onay, sunucu geri gelene kadar bekleme (maks. 5 dk) ve otomatik reboot sonrası kontrol (yeni çekirdek, container'lar Up/healthy). Reboot/upgrade sırasında erişim alarmları en fazla 10 dk susturulur.
- **Geri yükleme** (Gelişmiş): `RESTORE` yazdırma + native onay. pg_dumpall yedeği mevcut veritabanlarını silmez; en güvenlisi boş/yeni bir container'a yüklemektir. psql SQL hatalarında da başarılı döndüğü için çıktıdaki hatalar ayrıca sayılır: "zaten var" türü beklenen uyarılar yok sayılır, diğer hatalar (ör. `duplicate key`) varsa işlem başarısız raporlanır. `do-release-upgrade` kapsam dışıdır.

Her adım `maintenance.log` (JSONL) dosyasına yazılır.

### Tek tıkla yönetim (Ayarlar → Yönetim eylemleri)

Her işlem native bir onay penceresi ister ve yalnızca keşfedilmiş/izlenen container'lar için çalışır.

- **Container başlat / durdur / yeniden başlat:** Container'lar sekmesinde, container'ın durumuna göre.
- **Projeyi güncelle:** Proje ekranındaki "⟳ Güncelle" düğmesi, projenin container etiketlerinden okunan compose projesi, dizini ve dosyalarıyla `docker compose pull && up -d` çalıştırır. Upgrade gibi sunucuda oturumdan bağımsız çalışır (`~/serverpulse-maint/deploy-*.log`), çıktı canlı akar ve bu sırada container alarmları en fazla 10 dk susturulur. Compose v2 eklentisi gerekir; proje container'ları tek bir compose projesine ait olmalıdır.
- **Disk temizliği (Disk & Docker sekmesi):** "Güvenli temizlik" etiketsiz image'ları ve build önbelleğini, "Kullanılmayan tüm image'ları sil" hiçbir container'ın kullanmadığı image'ları siler. Volume'lara ve container'lara hiçbir modda dokunulmaz.
- **Loglar:** Son 200 / 1000 / 5000 satır, isteğe bağlı zaman aralığı (15 dk, 1 sa, 24 sa), filtre, dosyaya kaydetme ve 5 sn'de bir otomatik yenileme. Otomatik yenileme 10 dk sonra kendiliğinden durur ve her seferinde yeniden okur; sunucuda takip (`-f`) süreci bırakılmaz.

### Terminal (Ayarlar → Terminale izin ver)

Varsayılan olarak kapalıdır ve yönetim eylemlerinden ayrı bir ayardır. Açıkken sunucu ekranında bir **Terminal** sekmesi görünür: xterm.js ile, izleme bağlantısından bağımsız ayrı bir SSH oturumu açılır (host key yine doğrulanır) ve sekmeden çıkınca ya da pencere kapanınca oturum kapanır. Terminalde yazılan komutlar sunucuda doğrudan çalışır; uygulamanın komut beyaz listesi ve onay pencereleri burada geçerli değildir.

Host key sonradan değişirse bağlantı durdurulur ve kırmızı "host key değişti" alarmı verilir. Sunucu yeniden kurulduysa "Düzenle" ekranından parmak izini yeniden onaylayın.

### Görünürlük (salt okunur)

- **Ağ trafiği:** `/proc/net/dev` sayaçlarının farkından gelen/giden bayt/sn. Loopback, Docker (`docker*`, `veth*`, `br-*`) ve VPN (`tailscale*`, `wg*`, `tun*`) arayüzleri sayılmaz; VPN trafiği fiziksel arayüzde zaten göründüğü için iki kez sayılmaz.
- **Geçmiş ve uptime:** Grafikler 72 saate kadar ham örneklerden (30 sn'de bir), 7 ve 30 gün için 5 dakikalık özetlerden çizilir. Ham veri silinmeden önce özetlenir; özetler 30 gün tutulur. Proje kartındaki HTTP kontrolü rozeti son 24 saatin başarı oranını, üzerine gelince 7 ve 30 günü gösterir (%99,9 altı sarı, %99 altı kırmızı). Prometheus yalnızca isteğe bağlı bir alternatif olarak kalır.
- **Süreçler:** Sunucu ekranındaki kart, istendiğinde en çok CPU kullanan 15 süreci (`ps`) okur; periyodik çalışmaz.
- **Disk ayrıntıları (Disk & Docker sekmesi):** inode kullanımı (disk eşiği inode için de alarm üretir) ve log rotasyonu olmayan container'lar. `json-file` sürücüsünde `max-size` tanımlı değilse log dosyası sınırsız büyür; uygulama `daemon.json` örneğini gösterir.
- **Güvenlik sekmesi** (5 dk'da bir):
  - Son 24 saatteki başarısız SSH girişleri ve en çok deneyen 5 IP. `systemd-journal` grubu gerekir; okunamazsa "0 deneme" yerine uyarı gösterilir.
  - `PasswordAuthentication` / `PermitRootLogin` değerleri (root ise `sshd -T`, değilse yapılandırma dosyaları) ve öneriler.
  - fail2ban ve unattended-upgrades durumu.
  - Dinlenen TCP portları. İlk taramada bulunanlar taban kabul edilir; sonradan açılan her port uyarı üretir (`0.0.0.0`, `::`, `*` adresinde dinleyenler "dışa açık" diye ayrıca belirtilir). Beklenen bir değişiklikse "Mevcut portları taban kabul et" ile alarm kapanır.
- **Hafif mod (Ayarlar):** En pahalı komut olan `docker stats` 5 sn yerine 30 sn'de bir çalışır; aradaki turlarda son CPU/RAM değerleri gösterilir. 1 vCPU'lu sunucular için.

## Mimari

```
Electron main process
 ├─ ssh/connection.ts     Sunucu başına tek kalıcı ssh2 bağlantısı, keepalive, 2→60 sn üstel yeniden bağlanma,
 │                        TOFU host key doğrulaması, en fazla 4 eşzamanlı kanal
 ├─ ssh/commands.ts       TÜM sunucu komutlarının whitelist'i + girdi doğrulama (^[a-zA-Z0-9_.-]+$)
 ├─ collectors/           reach, host, docker, dockerMeta, systemd, httpLocal, httpPublic, ssl, postgres, asterisk,
 │                        storage, security
 ├─ parsers/              Saf parse fonksiyonları (fixture testli); bozuk çıktı → null/"bilinmiyor", istisna yok
 ├─ scheduler.ts          5 sn / 30 sn / 5 dk / 6 sa katmanları; aynı collector üst üste çalışmaz
 ├─ store/                config.json, secrets.json (safeStorage), history.sqlite (node:sqlite; 72 sa ham, 30 gün özet)
 ├─ alerts/               evaluate (durum → sorunlar, saf) + AlertEngine (debounce, flapping koruması)
 ├─ discovery/            Keşif çıktısından proje önerileri (saf, testli)
 └─ ipc.ts                Tipli IPC (src/shared/ipc.ts), sadece uygulamanın kendi pencerelerinden
Renderer (React + Tailwind + Recharts), contextIsolation + sandbox, nodeIntegration kapalı
 ├─ widget/               Frameless, sağ altta, içeriğe göre yükseklik
 └─ dashboard/            Sunucular → projeler → detay, grafikler, loglar, ayarlar, olaylar
```

Her collector tek bir SSH `exec` içinde birden çok komutu `@@S <bölüm>` / `@@RC <kod>` işaretleyicileriyle çalıştırır. Böylece her turda sunucuya birkaç kısa ömürlü kanal açılır ve hepsi komut bitince kapanır.

| Collector | Aralık | Nereden | Ne |
|---|---|---|---|
| reach | 30 sn | PC → TCP 22 + SSH `true` | Erişilebilirlik, gecikme |
| host | 5 sn | SSH: `/proc/*`, `nproc`, `df` | CPU % (iki /proc/stat farkı), RAM, swap, load, uptime, disk, ağ RX/TX |
| docker | 5 sn | SSH: `docker ps/stats/inspect` | Durum, health, restart sayısı, CPU/RAM, compose projesi (hafif modda `stats` 30 sn) |
| dockerMeta | 5 dk | SSH: `docker system df` | Image/volume/cache boyutları |
| systemd | 30 sn | SSH: `systemctl is-active`, `--failed` | Servis durumları |
| httpPublic | 30 sn | PC → HTTPS | Durum kodu, yanıt süresi |
| httpLocal | 30 sn | SSH: `curl 127.0.0.1:<port>` | İç health endpoint'leri |
| ssl | 6 sa | PC → TLS handshake | Sertifikanın bitmesine kalan gün |
| postgres | 30 sn | SSH: `docker exec pg_isready/psql` | Hazır mı, bağlantı sayısı, DB boyutları |
| asterisk | 30 sn | SSH: `sudo -n asterisk -rx …` | Aktif çağrı, trunk kaydı, endpoint'ler |
| storage | 5 dk | SSH: `df -i`, `docker inspect` | inode kullanımı, log rotasyonu olmayan container'lar |
| security | 5 dk | SSH: `journalctl`, sshd yapılandırması, `systemctl is-active`, `ss -tln` | Başarısız SSH girişleri, sshd ayarları, fail2ban/unattended-upgrades, dinlenen portlar |
| prometheus | isteğe bağlı | SSH `forwardOut` → 127.0.0.1:9090 | 24 sa / 7 / 30 günlük grafikler (yerel geçmişe alternatif) |

### Alarmlar (varsayılanlar Ayarlar'dan değiştirilebilir)

Sunucuya erişilemiyor (2 ardışık deneme) · SSH kimlik doğrulaması başarısız · container çalışmıyor/unhealthy/kayıp · restart sayısı arttı · HTTP 5xx/zaman aşımı (2 ardışık kontrol) · `pg_isready` başarısız (2 ardışık kontrol) · Asterisk trunk kayıtlı değil · disk ya da inode > %85 (%95 kritik) · RAM > %90 (5 dk boyunca) · SSL < 14 gün (3 günden az kritik) · izlenen systemd unit aktif değil · port tabanında olmayan yeni dinlenen port · host key değişti.

Bir sorun **10 sn boyunca kesintisiz** sürerse açılır ve bildirim gönderilir. Aynı süre boyunca görülmezse kapanır. 30 sn'de bir çalışan HTTP ve PostgreSQL kontrolleri için ayrıca **ardışık hata eşiği** (varsayılan 2) beklenir; tek seferlik bir aksaklık bildirim üretmez.

- **Kimlik doğrulama hatası:** Sunucu şifreyi/anahtarı reddederse bağlantı otomatik olarak yeniden denenmez (aksi halde fail2ban bu bilgisayarın IP'sini banlayabilir). Bilgileri güncelleyin ya da sunucu ekranındaki "Yeniden dene" butonunu kullanın.
- **Projeye atanmamış container'lar:** Hiç proje tanımlanmamışsa tüm container'lar izlenir; hiç başlamamış (`Created`) ya da normal biten (`Exited (0)`) tek seferlik container'lar alarm üretmez.
- **Uyku/uyanma:** Bilgisayar uykudan uyanınca bağlantılar hemen yeniden kurulur ve ağın toparlanması için 90 sn alarm değerlendirilmez.
- **İnternet bağlantınız yok:** Tüm sunuculara aynı anda TCP ile ulaşılamazsa uygulama genel adreslere (1.1.1.1, 8.8.8.8, 9.9.9.9) bağlanarak bu bilgisayarın internetini doğrular. Kesinti bu taraftaysa sunucu alarmları yerine tek bir "İnternet bağlantısı yok" uyarısı gösterilir; açık sunucu alarmları dondurulur (yanlışlıkla "düzeldi" sayılmaz). Bu uyarı Telegram/webhook'a gönderilmez.
- **Sessize alma:** Sunucu ekranındaki "🔕 Sessize al" (1 saat, 4 saat, yarın 09:00'a kadar) o sunucunun, sorun satırındaki "1 sa sessize al" yalnızca o sorunun bildirimlerini durdurur. Sorunlar listede ve olay geçmişinde görünmeye devam eder; sessizlik en fazla 30 gün sürer.
- **HTTP beklentileri:** Proje düzenleme ekranında her HTTP kontrolü için kabul edilen durum kodları (`200`, `200-299`, `200-399,401`), yanıtta aranacak metin ve "yavaş" eşiği (ms) tanımlanabilir. Yerel (SSH) kontrollerde metin sunucuda `grep -F` ile aranır, yanıt gövdesi bilgisayara taşınmaz. Eşik ardışık aşılırsa uyarı verilir.

### Telegram komutları ve günlük özet

Ayarlar → Harici bildirimler → Telegram açıkken:

- **Komutlar:** `/durum` (`/status`) sunucuların tek satırlık özetini, `/sorunlar` (`/issues`) açık sorunları gönderir. Bot yalnızca kayıtlı chat ID'den gelen mesajlara yanıt verir, salt okunurdur ve uygulama açıkken çalışır (webhook kurulmaz; `getUpdates` ile uzun yoklama).
- **Günlük özet:** Seçilen saatte aynı özet gönderilir. Uygulama o saatte kapalı ya da bilgisayar uykudaysa 2 saat içinde açıldığında gönderilir.

## Veriler nerede?

`%APPDATA%\ServerPulse` (Windows) · `~/Library/Application Support/ServerPulse` (macOS)

- `config.json`: sunucular (gizli bilgi olmadan), projeler, ayarlar
- `secrets.json`: şifre/anahtarlar, **safeStorage** ile şifreli (Windows DPAPI, macOS Keychain). Düz metin asla yazılmaz.
- `history.sqlite`: metrik örnekleri (30 sn'de bir, 72 sa), 5 dakikalık özetler (30 gün) ve alarm olayları (30 gün)

## Testler ve fixture'lar

`tests/fixtures/` altındaki çıktılar gerçek komut biçimlerine ve plandaki VDS envanterine göre hazırlanmıştır. `tests/discovery.test.ts` keşfin bu VDS'te 4 projeyi, 8 container'ı ve 3 domain'i bulduğunu doğrular (kabul referansı).

Gerçek çıktılarla çalışmak için `scripts/capture-fixtures.sh` betiğini sunucuda çalıştırın (salt okunurdur, kullanım talimatı betiğin başında). Toplanan dosyaları `tests/fixtures/` altına kopyalayın. Bazı testler fixture'daki belirli değerleri (ör. "Rejected" trunk) kontrol eder; gerçek çıktıya geçince bu beklentileri güncelleyin.

## Plandan bilinçli sapmalar

- **better-sqlite3 yerine `node:sqlite`:** Electron 44 (Node 24) içinde yerleşik olarak geliyor. Native modül derlemesi ortadan kalktığı için Windows ve macOS paketlemesi basitleşiyor. API ve şema aynı işi görüyor.
- **Container restart sayısı** 5 dakikalık `docker-meta` yerine 5 saniyelik docker collector'da (`docker inspect --format` ile tek satır) okunur. Böylece "restart artıyor" alarmı 5 dakika gecikmez.
- **Yönetim eylemleri** (container başlat/durdur/yeniden başlat, proje güncelleme, Docker temizliği, sunucu bakımı) varsayılan olarak kapalıdır. Ayarlar'dan açılabilir ve her seferinde main process'te native bir onay penceresi ister.
