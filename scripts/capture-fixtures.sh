#!/usr/bin/env bash
# Parser testleri için gerçek komut çıktılarını VDS'ten toplar. SALT OKUNURDUR; hiçbir şeyi değiştirmez.
#
# Kullanım (PC'den):
#   scp scripts/capture-fixtures.sh deploy@100.99.9.0:/tmp/
#   ssh deploy@100.99.9.0 'bash /tmp/capture-fixtures.sh /tmp/sp-fixtures && tar -C /tmp -czf /tmp/sp-fixtures.tgz sp-fixtures'
#   scp deploy@100.99.9.0:/tmp/sp-fixtures.tgz . && tar -xzf sp-fixtures.tgz
#   -> sp-fixtures/* dosyalarını tests/fixtures/ altına kopyalayıp `npm test` çalıştırın.
#
# Not: nginx dosyaları ve docker label'ları domain/dizin bilgisi içerir; çıktıyı paylaşmadan önce gözden geçirin.
set -u
OUT="${1:-./sp-fixtures}"
mkdir -p "$OUT"
export LC_ALL=C

cat /proc/loadavg > "$OUT/proc_loadavg.txt"
cat /proc/meminfo > "$OUT/proc_meminfo.txt"
cat /proc/uptime > "$OUT/proc_uptime.txt"
head -1 /proc/stat > "$OUT/proc_stat_1.txt"
sleep 2
head -1 /proc/stat > "$OUT/proc_stat_2.txt"
nproc > "$OUT/nproc.txt"
df -P -B1 -x tmpfs -x overlay -x devtmpfs -x squashfs -x efivarfs > "$OUT/df.txt" 2>&1

docker ps -a --no-trunc --format '{{json .}}' > "$OUT/docker_ps.jsonl" 2>&1
docker stats --no-stream --no-trunc --format '{{json .}}' > "$OUT/docker_stats.jsonl" 2>&1
docker ps -aq | xargs -r docker inspect --format '{{.Name}}|{{.RestartCount}}|{{.State.StartedAt}}' > "$OUT/docker_inspect.txt" 2>&1
docker system df --format '{{json .}}' > "$OUT/docker_system_df.jsonl" 2>&1

systemctl is-active nginx docker asterisk fail2ban tailscaled node_exporter > "$OUT/systemctl_is_active.txt" 2>&1
systemctl --failed --no-legend --plain > "$OUT/systemctl_failed.txt" 2>&1
systemctl list-units --type=service --state=running --no-legend --plain > "$OUT/systemctl_running.txt" 2>&1
ss -tlnH > "$OUT/ss_tln.txt" 2>&1
for f in /etc/nginx/sites-enabled/*; do [ -f "$f" ] && { echo "@@F $f"; head -c 200000 "$f"; echo; }; done > "$OUT/nginx_sites.txt" 2>&1

PG=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(^|\/)postgres(:|$)/ {print $1; exit}')
if [ -n "$PG" ]; then
  PGU=$(docker exec "$PG" printenv POSTGRES_USER 2>/dev/null || echo postgres)
  {
    echo '@@S ready'; docker exec "$PG" pg_isready -U "$PGU" 2>&1; echo "@@RC $?"
    echo '@@S conns'; docker exec "$PG" psql -U "$PGU" -d postgres -tAc "select count(*) from pg_stat_activity" 2>&1; echo "@@RC $?"
    echo '@@S sizes'; docker exec "$PG" psql -U "$PGU" -d postgres -tA -F '|' -c "select datname, pg_database_size(datname) from pg_database where not datistemplate" 2>&1; echo "@@RC $?"
  } > "$OUT/pg.txt"
fi

if [ "$(id -u)" = 0 ]; then P=""; else P="sudo -n "; fi
${P}/usr/sbin/asterisk -rx 'core show channels count' > "$OUT/asterisk_channels.txt" 2>&1
${P}/usr/sbin/asterisk -rx 'pjsip show registrations' > "$OUT/asterisk_registrations.txt" 2>&1
${P}/usr/sbin/asterisk -rx 'pjsip show endpoints' > "$OUT/asterisk_endpoints.txt" 2>&1

echo "Tamamlandı: $OUT"
ls -la "$OUT"
