#!/usr/bin/env bash
# deploy/nginx-sync-csp.sh — samakan CSP nginx peladen dengan CSP aplikasi (`CSP_POLICY`).
#
# Sebab: sejak 13 Sep 2026 nginx peladen mengirim header Content-Security-Policy sendiri. Sejak
# Wave 11A aplikasi juga mengirim header yang sama. Peramban menegakkan IRISAN kedua kebijakan, jadi
# dua nilai yang berbeda mempersempit kebijakan tanpa sengaja. Pada 26 Sep 2026 terukur: nilai lama
# di nginx tidak memuat fonts.googleapis.com/fonts.gstatic.com, sehingga berkas gaya Google Fonts
# diblokir di produksi padahal kedua nilai SUDAH memuatnya di repo. Skrip ini menutup celah itu.
#
# Cakupan perubahan HANYA header CSP di `server {}` dan satu blok `location` untuk berkas artefak
# mentah (gaya inline berbeda tetap diputuskan aplikasi). Sisa berkas tidak disentuh: jalur
# /lifeos-api/ dan /apk/ (milik aplikasi lain), HSTS, dan header keamanan lain dibiarkan apa adanya.
#
# Pemakaian:
#   deploy/nginx-sync-csp.sh            # cek saja (tanpa sudo, tanpa tulis) — DEFAULT
#   deploy/nginx-sync-csp.sh --apply    # cadangkan, tulis, `nginx -t`, lalu reload (butuh sudo -n)
#
# Golak-balik (rollback): skrip selalu menyalin berkas ke
#   /etc/nginx/sites-available/coder.sam.university.conf.bak.<stempel waktu>
# sebelum menulis. Untuk membatalkan: salin balik berkas .bak itu, lalu `sudo -n nginx -t` +
# `sudo -n systemctl reload nginx`.
set -euo pipefail

PELADEN="${PELADEN:-coder}"
CONF="/etc/nginx/sites-available/coder.sam.university.conf"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_RUJUKAN="$ROOT/coder-platform/nginx/coder.sam.university.conf"

# Nilai CSP dari salinan rujukan di repo: itu satu-satunya sumber angka di sini, sehingga
# menyalin barisnya dari repo tidak bisa "menghafal" nilai yang berbeda dari csp.ts.
CSP_BARU="$(grep -m1 'add_header Content-Security-Policy "' "$CONF_RUJUKAN" | sed -E 's/.*add_header Content-Security-Policy "([^"]*)".*/\1/')"
[ -n "$CSP_BARU" ] || { echo "GAGAL: nilai CSP tidak ditemukan di $CONF_RUJUKAN"; exit 1; }
case "$CSP_BARU" in *fonts.googleapis.com*) ;; *) echo "GAGAL: CSP rujukan tidak memuat fonts.googleapis.com"; exit 1;; esac
case "$CSP_BARU" in *unsafe-eval*) echo "GAGAL: CSP rujukan tidak boleh memuat unsafe-eval"; exit 1;; esac

MODE="${1:-cek}"
echo "MODE=$MODE"
echo "CSP_RUJUKAN_CHARS=${#CSP_BARU}"
echo "CSP_RUJUKAN=${CSP_BARU}"

# Nilai CSP memuat spasi dan titik koma, jadi dikirim sebagai base64 agar tidak dipecah shell dan
# tidak memicu $()/`` di sisi peladen.
CSP_B64="$(printf %s "$CSP_BARU" | base64 -w0)"

ssh -o BatchMode=yes "$PELADEN" MODE="$MODE" CONF="$CONF" CSP_B64="$CSP_B64" 'bash -s' <<'JAUH'
set -euo pipefail
CSP_BARU="$(printf %s "$CSP_B64" | base64 -d)"
LAMA="$(grep -m1 'add_header Content-Security-Policy "' "$CONF" | sed -E 's/.*Content-Security-Policy "([^"]*)".*/\1/')"
echo "CSP_NGINX_SEKARANG_CHARS=${#LAMA}"
echo "CSP_NGINX_SEKARANG=${LAMA}"
if [ "$LAMA" = "$CSP_BARU" ]; then echo "CSP_NGINX_SUDAH_SAMA=true"; else echo "CSP_NGINX_SUDAH_SAMA=false"; fi
echo "BLOK_ARTEFAK_ADA=$(grep -cF 'api/v1/artifacts/' "$CONF" || true)"

if [ "$MODE" != "--apply" ]; then
  echo "RENCANA_CSP_BARU=${CSP_BARU}"
  echo "RENCANA_TAMBAH_BLOK_ARTEFAK=$( [ "$(grep -cF 'api/v1/artifacts/' "$CONF" || true)" = "0" ] && echo ya || echo tidak )"
  echo "CEK_SAJA_SELESAI=true"
  exit 0
fi

STAMP="$(date +%Y%m%d%H%M%S)"
BAK="$CONF.bak.$STAMP"
sudo -n cp -a "$CONF" "$BAK"
echo "CADANGAN=$BAK"

# 1) Ganti nilai CSP di server {} dengan nilai dari repo. Hanya baris itu yang diubah.
sudo -n python3 - "$CONF" "$CSP_BARU" <<'PY'
import re, sys
path, baru = sys.argv[1], sys.argv[2]
teks = open(path, encoding="utf-8").read()
pola = re.compile(r'(add_header Content-Security-Policy ")[^"]*(" always;)')
teks2, n = pola.subn(lambda m: m.group(1) + baru + m.group(2), teks, count=1)
if n != 1:
    sys.exit("GAGAL: baris CSP tidak ditemukan tepat satu kali")
open(path, "w", encoding="utf-8").write(teks2)
print("BARIS_CSP_DIGANTI=" + str(n))
PY

# 2) Tambah blok location untuk berkas artefak mentah bila belum ada. Aplikasi memilih CSP per tipe
#    isi dan SENGAJA menghapus CSP untuk PDF (penampil PDF bawaan Chrome kosong bila `object-src
#    'none'` berlaku). Tanpa blok ini nginx menambahkan CSP-nya lagi ke jawaban PDF. Catatan nginx:
#    begitu sebuah location punya `add_header` sendiri, semua `add_header` warisan DIGUGURKAN — jadi
#    header keamanan lain dikembalikan di bawah, TANPA CSP.
if ! grep -q 'api/v1/artifacts/\[^/\]\+/(raw|download)' "$CONF"; then
  sudo -n python3 - "$CONF" <<'PY'
import sys
path = sys.argv[1]
teks = open(path, encoding="utf-8").read()
blok = """    # Berkas artefak mentah: aplikasi yang memutuskan CSP per tipe isi (dan menghapusnya untuk PDF).
    # Ditambahkan 26 Sep 2026 oleh deploy/nginx-sync-csp.sh.
    location ~ ^/api/v1/artifacts/[^/]+/(raw|download)$ {
        proxy_pass http://127.0.0.1:3402;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1800s;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    }

    # API Akun & Sinkron Personal Life OS (jalur Aaron)"""
lama = "    # API Akun & Sinkron Personal Life OS (jalur Aaron)"
if lama not in teks:
    sys.exit("GAGAL: titik sisip blok artefak tidak ditemukan")
teks = teks.replace(lama, blok, 1)
open(path, "w", encoding="utf-8").write(teks)
print("BLOK_ARTEFAK_DITAMBAH=true")
PY
else
  echo "BLOK_ARTEFAK_DITAMBAH=false"
fi

if ! sudo -n nginx -t 2>&1 | tee /tmp/nginx_t.out | grep -q 'syntax is ok'; then
  echo "NGINX_T_GAGAL=true"
  sudo -n cp -a "$BAK" "$CONF"
  echo "DIPULIHKAN_DARI_CADANGAN=true"
  exit 1
fi
echo "NGINX_T_OK=true"
sudo -n systemctl reload nginx
sleep 1
echo "NGINX_RELOAD_SELESAI=true"
echo "CSP_NGINX_SETELAH=$(grep -m1 'add_header Content-Security-Policy "' "$CONF" | sed -E 's/.*Content-Security-Policy "([^"]*)".*/\1/' | wc -c)"
echo "SYNC_CSP_SELESAI=true"
JAUH
