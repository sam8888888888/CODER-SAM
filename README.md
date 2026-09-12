# COBLAI — Dashboard Chat AI "Dinda" (snapshot kode)

Cadangan publik (source backup) untuk aplikasi web **chat.coblai.com** — dashboard chat AI
produk **COBLAI** dengan agen bernama **Dinda**.

Repo ini dibuat sebagai titik aman sebelum **perombakan total (redesign total) dashboard**,
supaya seluruh kode yang berjalan hari ini tersimpan utuh dan bisa dirujuk ulang.

> **Status repo:** snapshot cadangan + dokumentasi. Bukan paket siap pakai satu klik —
> butuh mesin Node.js, Docker, dan Prime Agent CLI untuk menjalankannya.

---

## 1. Apa isi repo ini

Tiga komponen yang membentuk layanan `chat.coblai.com`:

| Komponen | Peran | Berkas utama |
|---|---|---|
| **`coblai-chat`** (container) | Web server: menyajikan halaman + berkas statis, dan mem-proxy seluruh `/api/*` ke backend. Port 3102 | `server/chat-proxy-server.js`, `web/` |
| **`prime-agent-hub`** (container) | Backend API + orkestrasi agen. Menjalankan Prime Agent CLI dalam mode RPC, mengelola user, sesi, artefak, kuota, pembayaran. Port 3000 | `server/hub-server.js` (7.329 baris) |
| **`prime-agent-caddy`** (container) | Reverse proxy HTTPS (Caddy) + proteksi anti-bot/rate-limit | `deploy/Caddyfile` |

Alur request:

```
Internet → Caddy (443) → coblai-chat (3102, statis + proxy) → prime-agent-hub (3000, API + agen)
```

---

## 2. Struktur folder

```
.
├── web/                      Frontend versi TERLENGKAP (sumber revisi September)
│   ├── app.js                Logika aplikasi (chat, sesi, artefak, admin, kuota)
│   ├── index.html            Halaman utama + panel admin/pengaturan
│   ├── styles.css            Tampilan (tema gelap + ungu)
│   ├── sw.js                 Service worker (PWA, versi cache)
│   ├── manifest.json         Metadata PWA
│   ├── landing.html, daftar.html, konfirmasi.html, thankyou.html
│   └── icon-*.png, favicon*.png, apple-touch-icon.png
├── server/
│   ├── hub-server.js         Backend utama (API + spawn agen Prime Agent)
│   ├── chat-proxy-server.js  Proxy + penyaji berkas statis (container coblai-chat)
│   ├── entrypoint.sh         Entrypoint container backend
│   ├── stt.py                Transkripsi suara (speech-to-text)
│   ├── compose_images.py, export_answers.py   Utilitas gambar & ekspor jawaban
│   └── package.json
├── deploy/
│   ├── docker-compose.yml    Definisi stack (env dibaca dari .env — TIDAK disertakan)
│   ├── Dockerfile.hub, Dockerfile.chat
│   └── Caddyfile             Konfigurasi reverse proxy (IP pribadi disamarkan)
├── _snapshots/
│   ├── live-2026-09-12/      **Berkas yang BENAR-BENAR dilayani web hari ini** (versi 29 Agu)
│   └── hub-2026-09-07-*.js   Salinan frontend di sisi container backend (versi 7 Sep)
└── docs/                     Arsitektur, daftar endpoint, catatan versi
```

---

## 3. Identitas berkas (md5 — untuk membandingkan sebelum/sesudah perombakan)

| Berkas | Ukuran | Baris | md5 |
|---|---|---|---|
| `web/app.js` | 368.648 B | 5.972 | `c5e205eb4031acadae6bd4ef5efe0d27` |
| `web/index.html` | 125.051 B | 1.492 | `6ecd9b5f1f776cc17027c50700f323cc` |
| `web/styles.css` | 62.424 B | 951 | `8aa9d0511f00a2c0bf5ff85c0a149c2f` |
| `server/hub-server.js` | 416.801 B | 7.329 | `b78fa170a46af631f0f11bbc3dd9d3e3` |
| `server/chat-proxy-server.js` | 4.882 B | 108 | `b72570257b77a197d44af86d93e37834` |
| `_snapshots/live-2026-09-12/app.js` | 193.514 B | 3.327 | `cf1f09ac1cc478a5c06e50fc3a770eb9` |
| `_snapshots/live-2026-09-12/index.html` | 96.806 B | 1.163 | `31f7d5e6e84a1668c774b979e7551d50` |

Catatan penting soal perbedaan versi: lihat `docs/CATATAN-VERSI-2026-09-12.md`.

---

## 4. Fitur utama (dari kode, bukan klaim pemasaran)

- **Chat streaming** ke browser (SSE `/api/events`) + riwayat sesi, ganti nama, pin, branch, grup proyek.
- **Artefak**: berkas hasil kerja agen bisa dilihat/diunduh/di-embed; galeri per sesi.
- **Profil bot per user** (persona + pengetahuan), dipilih per sesi; ekspor/impor profil.
- **Kuota & biaya token** per user, laporan pemakaian harian, kalkulasi biaya Rupiah.
- **Panel admin**: user, kuota, kupon, pesanan, pembayaran, branding, log error, pemakaian token.
- **Autentikasi**: sesi cookie, login Google OAuth, **MFA** (TOTP + kode pemulihan).
- **Pembayaran**: Midtrans (QRIS/transfer), halaman daftar/konfirmasi/terima kasih.
- **Jalur pesan**: webhook Telegram & WhatsApp (Twilio), jembatan pesan masuk.
- **Pembelajaran**: aturan tetap (learnings), guardrails, memori user, benchmark internal, "dewan juri" penilai jawaban.
- **Keamanan**: enkripsi API key user (`enc:v1:`), izin tool per user, isolasi workspace per user, audit log JSONL.
- **PWA**: service worker + manifest, bisa dipasang di layar utama HP.

---

## 5. Menjalankan sendiri (ringkas)

```bash
# 1. Siapkan berkas env (JANGAN commit) — isi nama variabel di bawah
cp deploy/docker-compose.yml .
cat > .env <<'ENV'
DEEPSEEK_API_KEY=
OPENROUTER_API_KEY=
SERPER_API_KEY=
NOTION_API_KEY=
FAL_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ADMIN_USERNAME=
ADMIN_PASSWORD=
TELEGRAM_BOT_TOKEN=
CLOUDFLARE_API_TOKEN=
ENV

# 2. Jalankan stack backend + proxy
docker compose up -d --build

# 3. Frontend statis (coblai-chat) dijalankan terpisah dari Dockerfile.chat
docker build -f deploy/Dockerfile.chat -t coblai-chat .
docker run -d --name coblai-chat -p 127.0.0.1:3102:3102 coblai-chat
```

Backend membutuhkan **Prime Agent CLI** di dalam image (lihat `deploy/Dockerfile.hub`) dan minimal Node.js 22.
Data runtime (user, sesi, artefak) sengaja **tidak** disertakan di repo ini.

---

## 6. Keamanan & kredensial

- **Tidak ada kredensial** di repo ini: tidak ada `.env`, tidak ada berkas data user, tidak ada token/API key.
  Rincian pemindaian ada di [`SECURITY.md`](SECURITY.md).
- IP pribadi pada konfigurasi proxy disamarkan (`203.0.113.10`, IP dokumentasi).
- `.gitignore` menolak berkas env, data, cadangan, dan kunci — supaya kebocoran tidak terulang.

---

## 7. Lisensi

Perangkat lunak **proprietary** — hak cipta pemilik produk. Publik hanya untuk cadangan &
rujukan. Lihat [`LICENSE`](LICENSE).

---

*Disusun oleh Dato' Dr. H. Sami'an, M.B.A*
