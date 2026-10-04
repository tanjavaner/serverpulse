# ServerPulse

Sunucuları ve üzerindeki projeleri (Docker, systemd, .NET/TS backend'ler, PostgreSQL, Asterisk) VDS'e girmeden, kendi bilgisayarınızdan izleyen masaüstü uygulaması. Windows (x64) ve macOS (Apple Silicon) üzerinde çalışır.

**Agentless:** Sunucuya hiçbir şey kurulmaz. Uygulama SSH ile bağlanır, önceden tanımlı ve salt okunur komutları çalıştırır, çıktıyı kendi bilgisayarınızda parse eder. Sunucuda kalıcı süreç bırakılmaz; loglar yalnızca `--tail 200` / `-n 200` ile okunur, asla `-f` ile takip edilmez.

- **Widget (sağ alt):** Her sunucu için durum, CPU/RAM/Disk çubukları, "8/8 container sağlıklı", aktif çağrı sayısı ve açık sorunlar. Kırmızı durumlar en üstte gösterilir. Tıklanınca dashboard açılır.
- **Tray / menü çubuğu:** İkon rengi en kötü duruma göre değişir (yeşil, sarı, kırmızı, gri). Tıklayınca widget açılır/kapanır, sağ tık menüsünde Dashboard, Yenile ve Çıkış bulunur.
- **Dashboard:** Sunucu/proje ağacı, proje kartları (Backend/Frontend/DB/Asterisk rozetleri, HTTP yanıt süresi, SSL kalan gün, container CPU/RAM), 1 saat ile 72 saat arası grafikler (yerel SQLite), isteğe bağlı Prometheus (7 ve 30 gün), loglar, `docker system df`, olay geçmişi.
- **Alarmlar:** Durum değiştiğinde native bildirim gönderilir (debounce'lu). İsteğe bağlı olarak **Telegram** ve **webhook**'a da gider (Ayarlar → Harici bildirimler; token/URL işletim sistemi güvenli depolamasında şifreli saklanır).

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

Uygulama root ile de çalışır, ama salt okunur izleme için ayrı bir kullanıcı önerilir:

```bash
# 1) İzleme kullanıcısı (örnek: deploy). Docker'ı okuyabilmesi için docker grubuna eklenir.
sudo usermod -aG docker deploy
# journalctl ile servis loglarını okuyabilmesi için:
sudo usermod -aG systemd-journal deploy

# 2) SSH anahtarı (PC'de oluşturup sunucuya ekleyin)
ssh-keygen -t ed25519 -f ~/.ssh/serverpulse -C serverpulse
ssh-copy-id -i ~/.ssh/serverpulse.pub deploy@100.99.9.0
```

> Not: `docker` grubundaki bir kullanıcı pratikte root yetkisine yakın yetkiye sahiptir. Uygulama sadece whitelist'teki okuma komutlarını çalıştırır, fakat anahtarı buna göre koruyun.

### Asterisk (opsiyonel)

`asterisk -rx` genellikle root ister. Uygulamanın sadece üç okuma komutunu şifresiz çalıştırabilmesi için:

```bash
sudo visudo -f /etc/sudoers.d/serverpulse
```

```
deploy ALL=(root) NOPASSWD: /usr/sbin/asterisk -rx core show channels count, /usr/sbin/asterisk -rx pjsip show registrations, /usr/sbin/asterisk -rx pjsip show endpoints
```

Bu kural yoksa Asterisk için sadece `systemctl is-active asterisk` sonucu gösterilir. "Bağlantıyı test et" butonu kuralın çalışıp çalışmadığını `sudo -n -l` ile kontrol eder.

### Güvenlik önerisi (uygulama kapsamı dışında)

Bu VDS'te şu an `PasswordAuthentication yes` ve `PermitRootLogin yes` açık. Uygulama anahtarla ve tercihen Tailscale IP'si (`100.99.9.0`) üzerinden bağlanarak çalışır hale geldikten sonra `/etc/ssh/sshd_config` içinde bu iki ayarı kapatmayı düşünün. Kapatmadan önce anahtarla girişin çalıştığını ayrı bir oturumda doğrulayın.

## Kullanım

1. **Sunucu ekle:** Ad, host/IP, port, kullanıcı ve özel anahtar (veya şifre) girilir.
2. **Bağlantıyı test et:** Önce host key parmak izi gösterilir. Sunucuda `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` çıktısıyla karşılaştırıp onaylayın (TOFU). Sonra `uname -a`, `id`, docker erişimi ve Asterisk sudo kuralı kontrol edilir.
3. **Kaydet ve keşfet:** `docker ps` (compose label'ları), çalışan systemd servisleri, `ss -tln` ve `/etc/nginx/sites-enabled/*` okunur. Compose `working_dir` bir proje olarak, nginx `server_name` → `proxy_pass` portu da public URL olarak önerilir. Önerileri onaylayın veya düzenleyin.
4. Proje ekranında **Düzenle** ile health path'leri, container rollerini, Postgres kullanıcısını vb. ayarlayın.

### Sunucu bakımı (Bakım sekmesi)

Durum kontrolü (çekirdek, reboot gerekli mi, bekleyen/güvenlik güncellemeleri, restart politikası `no` olan container'lar) her zaman çalışır. Diğer işlemler **Ayarlar → Yönetim eylemleri** açıkken ve native onayla çalışır; sudo'nun şifresiz (`sudo -n`) çalışması gerekir.

- **Postgres yedeği:** `pg_dumpall | gzip` (`pipefail`), `gunzip -t` + "dump complete" + sha256 doğrulaması, SFTP ile `backups/<sunucu-id>/` altına indirme; sunucuda son 7 yedek tutulur. Container/kullanıcı sunucu ayarlarından ya da otomatik tespit edilir.
- **Güncelleme:** `apt-get update && upgrade` sunucuda oturumdan bağımsız çalışır (`~/serverpulse-maint/upgrade-*.log`), çıktı canlı akar. Son 24 saatte yedek yoksa önce yedek önerilir.
- **Reboot:** `REBOOT` yazdırma + native onay, sunucu geri gelene kadar bekleme (maks. 5 dk) ve otomatik reboot sonrası kontrol (yeni çekirdek, container'lar Up/healthy). Reboot/upgrade sırasında erişim alarmları en fazla 10 dk susturulur.
- **Geri yükleme** (Gelişmiş): `RESTORE` yazdırma + native onay. `do-release-upgrade` kapsam dışıdır.

Her adım `maintenance.log` (JSONL) dosyasına yazılır.

Host key sonradan değişirse bağlantı durdurulur ve kırmızı "host key değişti" alarmı verilir. Sunucu yeniden kurulduysa "Düzenle" ekranından parmak izini yeniden onaylayın.

## Mimari

```
Electron main process
 ├─ ssh/connection.ts     Sunucu başına tek kalıcı ssh2 bağlantısı, keepalive, 2→60 sn üstel yeniden bağlanma,
 │                        TOFU host key doğrulaması, en fazla 4 eşzamanlı kanal
 ├─ ssh/commands.ts       TÜM sunucu komutlarının whitelist'i + girdi doğrulama (^[a-zA-Z0-9_.-]+$)
 ├─ collectors/           reach, host, docker, dockerMeta, systemd, httpLocal, httpPublic, ssl, postgres, asterisk
 ├─ parsers/              Saf parse fonksiyonları (fixture testli); bozuk çıktı → null/"bilinmiyor", istisna yok
 ├─ scheduler.ts          5 sn / 30 sn / 5 dk / 6 sa katmanları; aynı collector üst üste çalışmaz
 ├─ store/                config.json, secrets.json (safeStorage), history.sqlite (node:sqlite, 72 sa retention)
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
| host | 5 sn | SSH: `/proc/*`, `nproc`, `df` | CPU % (iki /proc/stat farkı), RAM, swap, load, uptime, disk |
| docker | 5 sn | SSH: `docker ps/stats/inspect` | Durum, health, restart sayısı, CPU/RAM, compose projesi |
| dockerMeta | 5 dk | SSH: `docker system df` | Image/volume/cache boyutları |
| systemd | 30 sn | SSH: `systemctl is-active`, `--failed` | Servis durumları |
| httpPublic | 30 sn | PC → HTTPS | Durum kodu, yanıt süresi |
| httpLocal | 30 sn | SSH: `curl 127.0.0.1:<port>` | İç health endpoint'leri |
| ssl | 6 sa | PC → TLS handshake | Sertifikanın bitmesine kalan gün |
| postgres | 30 sn | SSH: `docker exec pg_isready/psql` | Hazır mı, bağlantı sayısı, DB boyutları |
| asterisk | 30 sn | SSH: `sudo -n asterisk -rx …` | Aktif çağrı, trunk kaydı, endpoint'ler |
| prometheus | isteğe bağlı | SSH `forwardOut` → 127.0.0.1:9090 | 7/30 günlük grafikler |

### Alarmlar (varsayılanlar Ayarlar'dan değiştirilebilir)

Sunucuya erişilemiyor (2 ardışık deneme) · container çalışmıyor/unhealthy/kayıp · restart sayısı arttı · HTTP 5xx/zaman aşımı · `pg_isready` başarısız · Asterisk trunk kayıtlı değil · disk > %85 (%95 kritik) · RAM > %90 (5 dk boyunca) · SSL < 14 gün (3 günden az kritik) · izlenen systemd unit aktif değil · host key değişti.

Bir sorun **10 sn boyunca kesintisiz** sürerse açılır ve bildirim gönderilir. Aynı süre boyunca görülmezse kapanır. Böylece flapping bildirim yağmuruna dönüşmez.

## Veriler nerede?

`%APPDATA%\ServerPulse` (Windows) · `~/Library/Application Support/ServerPulse` (macOS)

- `config.json`: sunucular (gizli bilgi olmadan), projeler, ayarlar
- `secrets.json`: şifre/anahtarlar, **safeStorage** ile şifreli (Windows DPAPI, macOS Keychain). Düz metin asla yazılmaz.
- `history.sqlite`: metrik örnekleri (30 sn'de bir, 72 sa) ve alarm olayları (30 gün)

## Testler ve fixture'lar

`tests/fixtures/` altındaki çıktılar gerçek komut biçimlerine ve plandaki VDS envanterine göre hazırlanmıştır. `tests/discovery.test.ts` keşfin bu VDS'te 4 projeyi, 8 container'ı ve 3 domain'i bulduğunu doğrular (kabul referansı).

Gerçek çıktılarla çalışmak için `scripts/capture-fixtures.sh` betiğini sunucuda çalıştırın (salt okunurdur, kullanım talimatı betiğin başında). Toplanan dosyaları `tests/fixtures/` altına kopyalayın. Bazı testler fixture'daki belirli değerleri (ör. "Rejected" trunk) kontrol eder; gerçek çıktıya geçince bu beklentileri güncelleyin.

## Plandan bilinçli sapmalar

- **better-sqlite3 yerine `node:sqlite`:** Electron 44 (Node 24) içinde yerleşik olarak geliyor. Native modül derlemesi ortadan kalktığı için Windows ve macOS paketlemesi basitleşiyor. API ve şema aynı işi görüyor.
- **Container restart sayısı** 5 dakikalık `docker-meta` yerine 5 saniyelik docker collector'da (`docker inspect --format` ile tek satır) okunur. Böylece "restart artıyor" alarmı 5 dakika gecikmez.
- **Yönetim eylemleri** (container restart) varsayılan olarak kapalıdır. Ayarlar'dan açılabilir ve her seferinde main process'te native bir onay penceresi ister.
