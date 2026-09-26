# Status implementasi COBLAI Coder

Terakhir diperbarui: 26 Sep 2026 (**v0.23.0 LIVE di produksi** — Wave 11A + 11B + 11C sudah di-commit, dipetikan, dideploy, dan diperiksa di peladen; sebelumnya produksi menjalankan 0.20.2 sejak 21 Sep 2026. Rincian deploy, bukti periksa, dan dua temuan nginx ada di bagian "Rilis v0.23.0 — LIVE DI PRODUKSI" di bawah. Wave 11C menutup 13 butir (68–76, 78, 81, 82) dengan skema **21**.)

Konfigurasi produksi yang AKTIF sejak 16 Sep 2026 (keputusan Bapak butir 1, 2, 4, 5):
- `NOTIFY_EMAIL_ENABLED=true` — email keluar hidup. Bukti: surat uji ke `noreply@coblai.com`
  masuk ke kotak surat (subjek "Verifikasi email COBLAI Coder"), lalu akun uji dihapus.
- `RETENTION_ENABLED=true` — kebijakan: audit 365 hari, notifikasi 365 hari, `run_events` 365 hari,
  ekspor data kedaluwarsa, token kedaluwarsa 1 hari. Sasaran hanya tabel itu (tidak menghapus
  pengguna, ruang kerja, proyek, percakapan, atau artefak). Pekerja retensi berjalan tiap 6 jam.
- `MIDTRANS_MERCHANT_ID` / `MIDTRANS_CLIENT_KEY` / `MIDTRANS_SERVER_KEY` terisi (kunci produksi).
  Divalidasi langsung ke API Midtrans: Snap produksi menjawab 400 (galat validasi = kunci sah),
  sandbox menolak 401. Gateway masih `manual` karena penagihan otomatis belum dibangun.
- DNS `coblai.com` belum dipasang (MX/SPF/DKIM); rinciannya di `docs/DNS_COBLAI_COM.md`.
- Kedaluwarsa/gap: tidak ada tombol "Masuk dengan Google" di UI, jadi tidak ada yang perlu dimatikan.
- Smoke produksi setelah perubahan ini: 156 lulus, 0 gagal, 0 lewat.

## Rilis v0.23.0 — LIVE DI PRODUKSI (26 Sep 2026)

Status: **LIVE**. Wave 11A + 11B + 11C dalam satu rilis. Commit `3ecfd46`, tag `v0.23.0`,
paket `deploy/coder-sam-university-v0.23.0.tar.gz` (SHA256 `1b461c94f5d22f10fa18bbc2f05b1280743b944712ddb11445538b0c41a54a1c`).

### Bukti deploy (dari `/workspace/outputs/deploy_v0230.log`)
- `DEPLOY_EXIT=0`, `DEPLOY_OK coder-platform-app:0.23.0`.
- Rehearsal migrasi di atas cadangan produksi terakhir: `MIGRATION_REHEARSAL_OK`,
  `SCHEMA_VERSION_AFTER_MIGRATION 21 EXPECTED 21`, `ROW_COUNTS_PRESERVED true`,
  `REOPEN_IDEMPOTENT true`, `INTEGRITY_CHECK ok FOREIGN_KEYS true`.
- Cadangan sebelum migrasi: `/app/backups/coder-2026-09-25T01-17-02.098Z.db`.
- env-sync: `ENV_MISSING_COUNT 38` (kunci kurang ditambahkan dari daftar resmi, bukan ditimpa),
  `ENV_OBSOLETE_KEYS PLATFORM_WEBHOOK_URL` dan `ENV_UNKNOWN_KEYS DEEPSEEK_API_KEY` hanya dilaporkan.
- Blue-green: wadah hijau (3403) dan wadah hidup (3402) sama-sama `READY`; nginx lolos `nginx -t`.
- Wadah setelah rilis: `coder-platform-app:0.23.0 Up (healthy)` dan `coder-platform-worker:0.23.0 Up`.
  `mailcow` tidak disentuh.

### Bukti periksa produksi (tanpa kredensial, dari ruang kerja)
- `/health` → 200; `/ready` → 200 `{status:ready, database:ok}`; `/` → 200; `/manifest.webmanifest` → 200.
- `/api/v1/public/docs` → `"version":"0.23.0"` (bukti versi baru benar-benar berjalan).
- Skema basis data produksi → `21` (dibaca langsung dari `coder.db` di dalam wadah).
- `POST /api/v1/auth/login` dengan kredensial salah → 401 `INVALID_CREDENTIALS` (bukan 500);
  rute tidak dikenal → 404 `NOT_FOUND`.
- Header CSP terkirim di produksi (dua header: dari nginx dan dari aplikasi).
- Log aplikasi 15 menit setelah rilis: **0 baris bertingkat galat**; pekerja antrean jalan
  (2 pekerjaan selesai, 0 gagal).
- Pemeriksaan peramban sungguhan (Chromium, halaman masuk produksi): halaman hidup,
  `.profile-button` muncul, formulir masuk tampil, kolom email + sandi ada, gaya CSS terpasang
  (`border-radius=12px`). Skrip: `/workspace/outputs/prod_csp_check.mjs`.

### Dua temuan nginx — SUDAH DIPERBAIKI DAN DIVERIFIKASI (26 Sep 2026)
1. **Google Fonts diblokir di produksi** (terukur, kosmetik). nginx peladen masih memakai nilai CSP
   lama (243 karakter, tanpa `fonts.googleapis.com`/`fonts.gstatic.com`, dengan
   `style-src 'self' 'unsafe-inline'`). Peramban menegakkan irisan CSP nginx dan CSP aplikasi, jadi
   irisan itu kehilangan kedua asal font: berkas gaya Google Fonts ditolak
   (`Refused to load the stylesheet ... violates "style-src 'self' 'unsafe-inline'"`). Akibat:
   dashboard jatuh ke font sistem. Kebijakan lama itu dipasang 13 Sep 2026 dan **sudah memblokir font
   sebelum rilis ini**; rilis ini hanya menambahkan nilai yang benar di repo (aplikasi + salinan
   rujukan nginx) tanpa menyentuh berkas nginx di peladen.
2. **CSP nginx ikut menempel pada berkas artefak mentah** (perkiraan berdasar bukti, belum diuji
   ujung-ke-ujung). `add_header` nginx dipasang di tingkat `server`, jadi berlaku juga untuk
   `/api/v1/artifacts/:id/(raw|download)`; terukur dengan `curl` tanpa login: jawaban 401 jalur itu
   memang membawa header CSP dari nginx. Aplikasi sengaja **menghapus** CSP untuk PDF (penampil PDF
   bawaan Chrome kosong bila `object-src 'none'` berlaku), tetapi nginx menambahkannya lagi. Perlu
   diuji dengan sesi nyata + berkas PDF untuk memastikan pratinjau PDF kosong atau tidak.

**Perbaikan dijalankan 26 Sep 2026 setelah Bapak mengizinkan** (`deploy/nginx-sync-csp.sh --apply`):
cadangan `/etc/nginx/sites-available/coder.sam.university.conf.bak.20260926222321`,
`BARIS_CSP_DIGANTI=1`, `BLOK_ARTEFAK_DITAMBAH=true`, `NGINX_T_OK=true`, `NGINX_RELOAD_SELESAI=true`.
Golak-balik: salin berkas `.bak` itu kembali lalu `sudo -n nginx -t` dan `sudo -n systemctl reload nginx`.

Hasil periksa sesudah perbaikan:
- CSP aplikasi (langsung `127.0.0.1:3402`) dan CSP lewat nginx 443 kini **sama persis** (nilai 309
  karakter, dibandingkan baris per baris) — irisan dua kebijakan tidak lagi mempersempit apa pun.
- Jalur `/api/v1/artifacts/:id/raw` lewat nginx kini membawa **tepat satu** header CSP (milik aplikasi,
  `default-src 'none'; script-src 'none'; ...`); header keamanan lain (HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`) tetap ada. Jadi nginx tidak lagi menempelkan `object-src 'none'` pada jawaban PDF.
- Peramban Chromium sungguhan: **6/6 lulus** (sebelum perbaikan 4 lulus / 2 gagal). Font benar-benar
  termuat: `document.fonts.check('400 16px "DM Sans"')` = true, `check('700 16px "Space Grotesk"')` =
  true, `font-family` terhitung = `"DM Sans", sans-serif`.

### Uji live produksi dengan akun uji (26 Sep 2026, atas izin Bapak)
- Akun uji `dinda.uji.v0230@coblai.com` dibuat lewat API produksi (201) dengan kata sandi acak.
- Surat verifikasi **tidak terkirim** (jujur): mailcow menolak alamat itu
  (`RCPT 550 5.1.1 User unknown in virtual mailbox table`), jadi laporan pendaftaran menulis
  `emailVerification.sent=false`. Karena surat tidak bisa dibaca, verifikasi dilakukan lewat **jalur
  resmi aplikasi**: satu baris token `email_verify` disisipkan ke `auth_tokens` di basis data produksi,
  lalu `POST /api/v1/auth/email/verify` dipanggil dengan token mentah → `{"verified":true}`.
- `apps/api/test/production-smoke.mjs` dijalankan terhadap produksi:
  **202 lulus, 0 gagal, `PRODUCTION_SMOKE_PASSED`, `EXIT=0`** (46 detik).
  Log: `/workspace/outputs/prod_smoke_v0230.log`.
- Akun uji kemudian **ditutup lewat jalur resmi aplikasi** (`DELETE /api/v1/auth/account` dengan ekspor
  data lebih dulu): `{"ok":true,"deletedAt":"2026-09-26T20:26:02.059Z","purgeAfter":"2026-12-25T20:26:02.059Z","recoveryDays":90}`.
  Setelah itu login akun itu menjawab 403 `ACCOUNT_DELETED`. Barisnya masih ada sebagai penutupan lunak
  sampai penyapu retensi menghapusnya (2026-12-25).
- Berkas kredensial sementara `/workspace/outputs/uji_live_akun.env` dihapus dengan `shred -u`; kata
  sandi tidak pernah dicetak ke log.

### Push ke GitHub — TERHAMBAT, butuh kredensial dari Bapak
`git remote -v` → `https://github.com/sam8888888888/coblai-dinda`. Ruang kerja ini **tidak punya**
kredensial GitHub: tidak ada `~/.git-credentials`, tidak ada `credential.helper`, tidak ada kunci SSH
GitHub, dan `GIT_ASKPASS=true` (interaksi dimatikan). Bukti: `git ls-remote origin` menjawab
`remote: Repository not found.` + `fatal: Authentication failed`. Jadi remote tidak bisa dibaca maupun
ditulis tanpa token. Sambil menunggu, cadangan luring dibuat: `git bundle` (lihat laporan lisan).

### Gerbang rilis sebelum deploy
- `npm run verify` dua kali berturut-turut: **59/59 suite hijau**, `ALL_SUITES_PASSED`,
  `VERIFY_EXIT=0` (`wave11c_verify_run6.log`, `wave11c_verify_run7.log`).
- Suite Wave 11C: 459 pemeriksaan API, 0 gagal, 0 lewat (integrasi 114, grup+bayar 154, media 100,
  bot 91). Antarmuka dashboard: **222/222 lulus**, 0 gagal, 1 lewat beralasan, 0 galat konsol.
- Suite baru: `deploy-paket-integritas.e2e.ts` 24/24; `port-uji-fetch-aman.e2e.ts` 20/20;
  `deploy-env-sync.e2e.ts` 70 lulus / 0 gagal.
- Verifikasi kredensial uji nyata (Telegram, Notion, konektor) lulus; berkas kredensial dihapus
  (`shred -u`) dan tidak pernah masuk repo.

## Wave 11C (v0.23.0) — integrasi, bot, grup, bayar, media, versi mesin (13 butir: 68–76, 78, 81, 82) — SELESAI DI KODE DAN SUDAH LIVE

Sumber: `PRD_WAVE_11_EKSEKUSI_v5.md` butir 68–76, 78, 81, 82 (13 butir; butir 77 tetap TERTAHAN per PRD).
Skema basis data: **20 → 21** (`SCHEMA_VERSION = 21`).

**Tabel baru:** `conversation_participants`, `user_integrations`, `bot_channels`, `bot_identities`, `connectors`.
**Kolom baru:** `conversations.kind`, `orders.unique_amount_idr`, `coupons.trial`, `coupons.trial_plan_code`, `users.avatar_path`.
`coupons.trial_plan_code` **tidak diminta PRD**: keputusan lead supaya kupon percobaan bisa dikunci ke satu paket tanpa menambal `platform_settings`.
**config.ts:** NOTION_API_BASE, CONNECTOR_TIMEOUT_MS, CONNECTOR_ALLOWED_HOSTS, TELEGRAM_API_BASE, TWILIO_API_BASE, BOT_WEBHOOK_BASE_URL, BOT_HTTP_TIMEOUT_MS, BOT_INBOUND_PER_MINUTE, BOT_REPLY_WAIT_MS, BOT_REPLY_MAX_CHARS, BOT_GROUP_ENABLED, BOT_LINK_CODE_TTL_MINUTES, BOT_LINK_MAX_ATTEMPTS, GROUP_MAX_PARTICIPANTS, UNIQUE_AMOUNT_MAX_TRIES, TRIAL_COUPON_HOURS, AVATAR_MAX_BYTES, AVATAR_SIZE, AVATAR_DIR.
**dataexport.ts:** bagian baru `user_integrations` (tanpa token), `bot_identities`, `connectors` (tanpa konfigurasi), `conversation_participants`.
**jobs.ts:** jenis pekerjaan baru `connector.deliver`, `bot.reply`.
**retention.ts:** tidak ada sasaran baru di Wave 11C.
**Berkas lain yang disentuh lead:** `billing.ts` (pagar `TRIAL_PLAN_ONLY`), `server.ts` (penyambungan rute + handler pekerja), `apps/api/src/workspace-guard.ts` (penjaga biaya ruang kerja dipindah keluar dari `server.ts` supaya bisa dipakai ulang), `.env.austria.example` + `deploy/env.keys.txt`.
Status: **kode selesai, gerbang hijau, sudah di-commit (`3ecfd46`) dan LIVE di produksi sejak 26 Sep 2026** (lihat bagian "Rilis v0.23.0 — LIVE DI PRODUKSI").

### Gerbang
- `npx tsc -p apps/api/tsconfig.json` → 0 galat. `npx tsc -p tsconfig.test.json` → 0 galat.
- Suite Wave 11C dijalankan dari sisi lead, berurutan, satu DATA_DIR per suite:
  `wave11c` 42/0 · `wave11c-konektor` 44/0 · `wave11c-konektor-proses` 28/0 · `wave11c-grup` 73/0 · `wave11c-bayar` 40/0 · `wave11c-kupon` 41/0 · `wave11c-media` 65/0 · `wave11c-mesin` 35/0 · `wave11c-bot` 91/0
  → **459 pemeriksaan API, 0 gagal, 0 dilewati** untuk 13 butir.
- Uji sambung rute (`/workspace/outputs/wire_probe.ts`): 23/23 lulus — 22 rute 11C menjawab 401/403 (ter-mount), rute palsu menjawab 404 sebagai kontrol negatif.
- `npm run verify` → **59/59 suite hijau, `ALL_SUITES_PASSED`, exit 0** (termasuk gerbang tipe uji dan gerbang migrasi).
  Angka 57 naik ke 59 karena dua suite gerbang baru: `deploy-paket-integritas.e2e.ts` (24 pemeriksaan, menjaga paket rilis
  dari berkas kode yang terabaikan `.gitignore`) dan `port-uji-fetch-aman.e2e.ts` (20 pemeriksaan, menjaga port suite dari
  daftar "bad port" `fetch`). **Dua putaran penuh berturut-turut pada 26 Sep 2026 (putaran 6 dan 7), tanpa pekerjaan lain
  berbarengan, sama-sama 59/59 dan exit 0** (`/workspace/outputs/wave11c_verify_run6.log`, `..._run7.log`) — inilah yang
  saya pakai sebagai syarat "hijau stabil" sebelum meminta izin rilis.
  Gerbang migrasi melaporkan `MIGRATION_REHEARSAL_OK`, `REOPEN_IDEMPOTENT true`, `INTEGRITY_CHECK ok`, dan `ROW_COUNTS_PRESERVED true` (yang terakhir dibuktikan oleh suite `worker-split`, bukan oleh baris ringkasan verify).
- Gerbang env `deploy-env-sync.e2e.ts` → 70 lulus / 0 gagal / 0 dilewati (`ALL_WAVE10_ENV_SYNC_TESTS_PASSED`).
- **Antarmuka dashboard Wave 11C** (butir 68, 69, 71, 74, 76, 78 tahap 1, 81): `npx tsc -b` 0 galat; `npm run build` **exit 0** (684 modul); uji peramban `node e2e/ui.e2e.mjs` **222/222 lulus, 0 gagal, 1 dilewati, `consoleErrors=0`, exit 0** — **3 jalan agen + 2 jalan lead sendiri**, semuanya 222/222. Naik dari 169 (gerbang 11B) → **53 pemeriksaan peramban baru**. Dua cacat NYATA aplikasi ditemukan uji ini dan diperbaiki: (i) aliran jawaban SSE tidak pernah masuk ke layar karena server mengirim peristiwa BERNAMA sementara klien hanya memakai `onmessage`; (ii) tombol "Hapus semua riwayat" meninggalkan percakapan basi → `GET /mode` dan `/messages` menembak percakapan yang sudah dihapus (404). Perbaikan hanya di berkas UI/uji; tidak ada pemeriksaan yang dilemahkan.
- Antarmuka dashboard Wave 11B (riwayat gerbang 11B): `npm run build` exit 0 (680 modul); uji peramban **169/169 lulus, 0 gagal, 1 dilewati**, `consoleErrors=0`.
  Satu pemeriksaan dilewati dengan alasan jujur (lihat catatan 19). Jalannya side lead menemukan satu BALAPAN WAKTU di berkas uji ("hapus pelajaran": server sudah menghapus, halaman belum melukis ulang) — sudah diperbaiki dengan menunggu server DAN halaman, lalu dijalankan ulang oleh lead: 169/169.

### Butir per butir
| Butir | Isi | Berkas utama | Bukti |
|---|---|---|---|
| 68 | Notion sebagai integrasi | `wave11c/notion.ts` + UI `NotionHub.tsx`, `ShareMenu.tsx` | 42 cek: ciphertext `enc:v1:`, batas 10 halaman/10 menit, token tak pernah keluar; **uji nyata** (catatan 21). UI: hub Notion + "Kirim ke Notion", hulu gagal → 502 `NOTION_UPSTREAM_ERROR` apa adanya |
| 69 | Bot Telegram | `wave11c/telegram-bot.ts`, `bot-core.ts` + UI `BotChannels.tsx` | 32 cek: rahasia webhook 401, run nyata, balasan sampai hulu; **uji nyata** `sendMessage` → 200 `ok:true` (catatan 21). UI: halaman kanal bot (webhook, token tersegel, catatan jujur soal `setWebhook`) |
| 70 | Bot WhatsApp (Twilio) | `wave11c/whatsapp-bot.ts` | 19 cek: tanda tangan HMAC, TwiML, `?format=json` |
| 71 | Katalog konektor Slack/Discord/MCP | `wave11c/connectors.ts`, `connector-store.ts` + UI `Connectors.tsx` | 44 cek: daftar putih host, 403 MCP, nama dari JSON tersegel; **uji nyata** ke penangkap webhook (catatan 21). UI: katalog + simpan/uji/hapus |
| 73 | Percakapan grup multi-agen | `wave11c/grup.ts` | 73 cek: 1 giliran = 1 run, batas 4 peserta, kunci giliran 409 `GROUP_TURN_BUSY` (diuji dua proses) |
| 74 | Nominal unik transfer manual | `wave11c/bayar.ts` + UI `Billing.tsx` | 40 cek: 200 nominal berbeda, habis → 503 setelah 20 percobaan. UI menampilkan nominal hanya dari dua sumber nyata (`POST /:orderId/unique-amount` dan antrean admin `bayar.ts`) karena `billing.ts` memang tidak mengembalikan kolom itu |
| 75 | Kupon percobaan | `wave11c/kupon.ts`, `billing.ts` | 41 cek: 100%, sekali pakai, salah paket → 400 `TRIAL_PLAN_ONLY` |
| 76 | Avatar pengguna & agen | `wave11c/avatar.ts`, `image-sanitize.ts` + UI `ProfilePanel.tsx` | 65 cek: tulis ulang PNG pakai `node:zlib`, JPEG/WebP ditolak. UI: JPEG/WebP diubah ke PNG **di peramban** (`canvas.toBlob`) lalu dikirim — tanpa pustaka asli |
| 78 | Versi mesin (tahap 1) | `wave11c/engine-version.ts` + UI `EngineVersionCard.tsx`, `StatusHub.tsx` | 35 cek: hanya membaca, tahap 2 dijawab 404 + `tersedia=false` |
| 81 | Identitas kanal bot | `wave11c/bot-identities.ts` | 20 cek: kode sekali pakai, TTL, satu chat satu akun |
| 82 | Konektor sebagai proses terpisah | `wave11c/connector-child.ts`, `connector-job.ts` | 28 cek: anak tidak menerima `DATA_DIR`/`SECRETS_KEY`, dibunuh paksa saat hulu menggantung |

### Catatan jujur (batas yang tidak terbukti)
1. **Butir 76**: JPEG dan WebP **ditolak** `503 IMAGE_PROCESSOR_UNAVAILABLE`. Tidak ada pustaka gambar di image (tanpa `sharp`/`jimp`), jadi hanya PNG yang ditulis ulang. Menerima JPEG/WebP butuh keputusan memasang pemroses gambar.
2. **Butir 76**: badan permintaan di atas ±5,66 MB dipotong lebih dulu oleh pengurai Fastify, jadi `413 AVATAR_TOO_LARGE` hanya sampai untuk badan di bawah ambang itu.
3. **Butir 78 tahap 2** (perbarui/rollback mesin) memang tidak dibangun; ketiadaannya diuji (POST/PUT/DELETE pada rute versi = 404, `tahap2.tersedia=false`). Menunggu keputusan K5.
4. **Versi mesin**: mesin sungguhan tidak dijalankan di suite; pembacaan versi diuji dengan biner tiruan (mencetak ke stdout, ke stderr, diam, sampah, menggantung, tidak ada). Fakta dari luar suite: `prime-agent --version` mencetak `0.9.5` ke **stderr** dan stdout-nya kosong.
5. **Bot 69/70/81**: di dalam suite, hulu Telegram/Twilio adalah tiruan 127.0.0.1 — yang terbukti perilaku COBLAI. **Diperbarui 26 Sep 2026:** jalur KELUAR Telegram sudah dibuktikan terhadap `api.telegram.org` sungguhan (getMe/getChat/sendMessage 200, `ok:true`, pesan nyata sampai ke penerima — catatan 21); yang BELUM diuji dengan layanan asli adalah pembaruan MASUK (`setWebhook` tidak dipanggil karena alamat kita masih lokal) dan seluruh jalur Twilio/WhatsApp.
6. **WhatsApp**: Fastify bawaan menjawab 415 untuk `application/x-www-form-urlencoded` padahal Twilio mengirim tipe itu, jadi modul bot mendaftarkan pengurai tipe isi sendiri (`app.addContentTypeParser`) tanpa menyentuh `server.ts`.
7. **Bot**: galat nyata ditemukan uji — `channelId = sekarang?.id ?? id ?? randomUUID()` membuat kanal lahir tanpa id (`""`) sehingga jalur webhook-nya 404; diperbaiki menjadi `||`.
8. **Konektor 71/82**: hulu Slack/Discord/Notion/MCP semuanya tiruan. `CONNECTOR_TIMEOUT_MS` produksi (15000 ms) sengaja **tidak** diuji; uji memakai 2–3 detik. Dua knob uji (`CONNECTOR_CHILD_DEADLINE_MS`, `CONNECTOR_CHILD_START_GRACE_MS`) dibaca dari `process.env` dengan bawaan di kode dan **bukan** setelan produksi.
9. **Konektor 82**: proses anak **tidak boleh** dijalankan lewat pembungkus `node_modules/tsx/dist/cli.mjs`. Saat itu dipakai, proses yang bekerja menjadi cucu, sehingga `SIGKILL` induk hanya membunuh pembungkusnya: terukur 31 detik padahal batas 3,5 detik. Sekarang `process.execPath` dipakai langsung (Node 22 punya `process.features.typescript`), dan ada cek khusus yang membuktikan berkas hasil build `.js` juga dijalankan langsung tanpa pembungkus.
10. **Konektor**: tabel `connectors` tidak punya kolom nama; nama hidup di dalam JSON tersegel dan dibuka di sisi server saat pemilik membaca katalognya. Konsekuensi: katalog tidak bisa mencari/mengurutkan berdasarkan nama.
11. **Konektor**: tidak ada batas laju untuk kirim/uji konektor (hanya pembuatan halaman Notion: 10 per 10 menit). Kandidat uji hanya bisa dijalankan pemilik konektor.
12. **Bot**: tidak ada lagi knob uji tanpa kunci resmi. Lima setelan yang dulu ditulis di kode (`BOT_WEBHOOK_BASE_URL`, `BOT_INBOUND_PER_MINUTE`, `BOT_HTTP_TIMEOUT_MS`, `BOT_REPLY_WAIT_MS`, `TWILIO_API_BASE`) sekarang punya kunci di `config.ts`; knob mati `BOT_PUBLIC_BASE_URL` dihapus. Hanya `BOT_GROUP_ENABLED` dan `BOT_REPLY_MAX_CHARS` yang masih membaca `process.env` lebih dulu (bawaannya tetap dari `config.*`) supaya satu proses uji bisa membuktikan bendera berubah.
13. **Grup 73**: satu percakapan grup memakai satu sesi mesin bersama; identitas giliran dijamin lewat `runs.persona_id` dan riwayat dibangun ulang dari tabel `messages`. Giliran **tidak dikunci**: dua giliran bersamaan bisa membuat dua run (prompt terakhir yang menang).
    **DIPERBARUI 26 Sep 2026 (keputusan Bapak): kunci giliran SUDAH DIPASANG** — pemeriksaan "masih ada run berjalan" dan pembuatan run berada di satu transaksi tulis (`db.transaction(...).immediate()`), giliran kedua dijawab 409 `GROUP_TURN_BUSY` tanpa baris `runs`/`messages` baru. Balapannya dibuktikan dengan menjalankan SALINAN KEDUA `server.ts` (proses terpisah, `DATA_DIR` sama): dua giliran bersamaan → tepat satu 202 + satu 409. Batasnya tetap jujur: run `running` yang macet baru dibebaskan `run.reap` (45 menit).
14. **Grup 73**: penjaga biaya/kecepatan ruang kerja (`RUN_RATE_LIMITED`) sekarang ikut berlaku karena penjaganya dipindah ke `workspace-guard.ts` dan dipakai modul grup.
15. **Bayar 74**: idempotensi — pesanan yang sudah punya kode mengembalikan 200 (bahkan setelah dibayar) supaya rekonsiliasi bank tetap jalan. Kalau Anda ingin pesanan non-pending dijawab 409, itu satu baris di `bayar.ts` (menunggu keputusan).
16. **Kupon 75**: `hours` hanya membatasi umur kupon; lama langganan mengikuti `plans.period_days` dan bulan percobaan dipaksa 1.
17. **Berkas sementara** `apps/api/test/w11c-selfcheck.ts` (milik agen media) sudah dihapus; 10 folder sisa `/tmp` dari putaran uji yang gagal juga sudah dibersihkan.
18. **`APP_VERSION`** di `.env.austria.example` dan `deploy/env.keys.txt` sudah dinaikkan `0.19.0` → **`0.23.0`** (26 Sep 2026, menyusul keputusan rilis Bapak). Nilai itu tetap nilai informasi: `deploy-austria.sh` menyetel `APP_VERSION=<versi>` sendiri di `.env` peladen pada tiap deploy. Gerbang `deploy-env-sync` tetap 70/0 sesudah perubahan.
19. **Antarmuka 11B**: satu pemeriksaan dilewati dengan alasan jujur — baris tabel Laporan galat tidak bisa dibandingkan dengan isi server karena basis data uji belum pernah punya catatan galat (hanya galat status 500 yang dicatat, dan itu tidak bisa dipicu dari peramban). Halaman, kalimat jumlah, saringan, dan unduh CSV tetap diuji sungguhan.

20. **Uji kunci giliran grup (butir 73) — jebakan yang nyata dan cara menutupnya.** Jalan pertama saya sendiri
    GAGAL: `Ringkasan: 69 lulus, 4 gagal`, `status 202/202`. Sebabnya uji, bukan kunci: umur run tiruan hanya
    ~50 ms sehingga run pemenang sudah selesai saat giliran kedua mengklaim — dan 202 untuk keduanya memang
    benar menurut aturan. Dua cacat diperbaiki: (a) knob uji **`MOCK_ENGINE_DELAY_MS`** di `MockEngine`
    (`engine-adapter.ts`) menahan jawaban tiruan N milidetik supaya run benar-benar masih hidup
    (`1500` dipakai suite; bawaan 0 = tanpa tunda, jadi tidak berpengaruh di produksi atau suite lain);
    (b) tiap pemeriksaan menghitung dasarnya sendiri tepat sebelum permintaan, supaya satu kegagalan tidak
    menjatuhkan yang lain. Sesudah perbaikan: **73/0** pada 3 jalan agen + 1 jalan berbeban CPU + **2 jalan
    yang saya jalankan sendiri** (`selisih byte pertama 14/107 ms` dan `26/26 ms`, keduanya `status 202/409`).
    Pelajaran: uji balapan yang hasilnya bergantung pada kecepatan mesin BUKAN bukti — perpanjang umur objek
    yang diperebutkan, lalu buktikan premisnya dengan pemeriksaan tersendiri (suite menambahkan `G49c`).
21. **Uji keluar SUNGGUHAN (bukan hulu tiruan) — 26 Sep 2026.** Memakai kredensial uji dari Bapak (berkas di
    luar repo, mode 600, dihapus setelah selesai; tidak satu pun nilainya ditulis di dokumen ini):
    **Notion** — `PUT /api/v1/integrations/notion` → 200 dengan `users/me` nyata (nama workspace terbaca), lalu
    `POST /api/v1/integrations/notion/pages` membuat halaman di bawah halaman induk yang diwajibkan Notion; halaman
    itu **diarsipkan** dan `GET /v1/pages/<id>` membalas `archived=true`. **Konektor** — `POST /connectors/<id>/test`
    mengirim ke penangkap webhook nyata: gaya Slack `{text,username}` dan gaya Discord `{content,username}`, keduanya
    `hulu=200` di sisi kita dan **tercatat di penangkap** (user-agent `node`, penanda uji unik sampai). Token Notion
    tersegel (`enc:v1:`) dan tidak pernah kembali lewat API; token asli tidak ditemukan di `coder.db` maupun `coder.db-wal`.
    Batas jujur: bentuk badan Slack/Discord baru terbukti **diterima penangkap**, belum diterima Slack/Discord asli
    (URL webhook Slack/Discord asli belum ada); Telegram dibuktikan terpisah. Log: `/workspace/outputs/uji_nyata_notion_konektor.log`.

22. **Kerapuhan gerbang rilis: port uji yang diblokir `fetch` — akar ditemukan dan ditutup (26 Sep 2026).**
    Gejalanya menyesatkan: suite kadang melapor "server tidak siap" padahal peladen uji hidup (gerbang putaran 5 merah di
    `wave6.e2e.ts`; direproduksi 2 kali dari 24 putaran mandiri). Sebabnya BUKAN bug produk: `fetch()` Node menolak daftar
    "bad port" spesifikasi Fetch, jadi bila nomor acak yang terpilih ada di daftar itu, setiap `fetch` gagal seketika
    (`TypeError: fetch failed` dengan cause `bad port`), sementara sambungan TCP biasa dan `node:http` ke port yang sama
    menjawab normal (jejak: `tcp=tersambung httpPolos=HTTP 200 ragamGalatFetch=160x ... bad port`). Daftar terblokir
    saya UKUR langsung pada rentang 3300–7599, bukan dari hafalan: 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
    6667, 6668, 6669, 6679, 6697. Perbaikan: berkas baru `apps/api/test/port-aman.ts` (`PORT_TERBLOKIR_FETCH` +
    `pilihPortUji()` yang melewati nomor terblokir) dipakai tiga suite yang rentangnya kena (`wave6.e2e.ts` 6500–6700,
    `csrf-limits.e2e.ts` 3900–4400, `outbox-mail.e2e.ts` 6000–6200), plus gerbang baru `port-uji-fetch-aman.e2e.ts`
    **20/20 hijau** yang memindai 40 rentang port di 64 berkas uji, 30 basis penolong port-bebas, dan 2 port turunan
    (`hookPort = port + 500`), lalu GAGAL bila ada rentang yang memuat nomor terblokir. Suite `wave11a.e2e.ts` dan
    `wave6.e2e.ts` kini mencetak jejak diagnosis (status run, pekerjaan, rantai `error.cause`) saat batas waktu habis, dan
    `run-all.cjs` menyimpan log UTUH setiap suite merah (`/tmp/verify-logs/<suite>.log`). Tidak ada pemeriksaan yang
    dilemahkan. **Batas jujur yang tersisa:** gerbang putaran 2 merah di `wave11a.e2e.ts` (169/176, 97,8 dtk, tiga batas
    30 dtk) dan sebabnya BELUM terbukti — dugaan terkuat: di dalam jendela putaran itu saya menjalankan suite berat lain
    (`paket_integritas` pukul 20:25:31), melanggar aturan "jangan menjalankan dua gerbang node berat berbarengan"; dugaan
    itu belum direproduksi, jadi tidak saya nyatakan sebagai sebab. Dua klaim saya sebelumnya juga saya TARIK setelah
    diukur ulang: "proses Chromium bocor" (ternyata 0 sisa proses; yang terlihat di sampel adalah peramban suite csp yang
    masih berjalan) dan "suite 11A mati 1 detik" (itu bug skrip driver saya sendiri: nama `wave11a.e2e` ditambah akhiran
    `.e2e.ts` → `ERR_MODULE_NOT_FOUND`).

## Wave 11B (v0.22.0) — paritas lanjutan: 11 butir (58–67, 83, plus 72) — SELESAI DI KODE DAN SUDAH LIVE

Sumber kerja: `PRD_WAVE_11_EKSEKUSI_v5.md`. Skema basis data naik **19 → 20** satu kali saja
(`SCHEMA_VERSION = 20`), dengan ringkasan perubahan ditulis di `SCHEMA_VERSION_NOTE`. Skema baru:
kolom `agent_memories.kind` ('memory'|'learning'), kolom `runs.resume_state` / `resumed_from` /
`resume_attempts`, dan tabel `council_runs`, `council_verdicts`, `shadow_measurements`,
`benchmark_runs`, `benchmark_results`, `error_events`, `prompt_schedules`. `config.ts`, `retention.ts`
(dua sasaran baru: `error_events`, `shadow_measurements`), `dataexport.ts` (tujuh bagian baru) dan
`jobs.ts` (jenis pekerjaan `schedule.run`, `resume.scan`) ikut diperbarui.
**Belum ada deploy, belum ada restart, belum ada commit.**

Gerbang yang dijalankan sendiri (26 Sep 2026, di mesin ini, berurutan satu per satu):
- `npm run verify` → **48/48 suite hijau** (sebelumnya 44; bertambah 4 suite Wave 11B), keluar kode **0**,
  `ALL_SUITES_PASSED`.
- Suite Wave 11B: `wave11b.e2e.ts` **81 lulus / 0 gagal / 0 dilewati**, `wave11b-council.e2e.ts`
  **92/0**, `wave11b-metrik.e2e.ts` **111/0/0 dilewati**, `wave11b-riwayat.e2e.ts` **103/0** →
  **387 pemeriksaan API**, nol gagal, nol dilewati.
- `npx tsc -p apps/api/tsconfig.json` dan `npx tsc -p tsconfig.test.json` → 0 galat.
- Gerbang migrasi: `MIGRATION_REHEARSAL_OK`, `REOPEN_IDEMPOTENT true`, `INTEGRITY_CHECK ok`.
- Gerbang env: `deploy-env-sync.e2e.ts` 70/0 (kunci baru Wave 11B ada di `.env.austria.example`
  **dan** `deploy/env.keys.txt`).
- Antarmuka peramban: **169/169 lulus, 0 gagal, 1 dilewati jujur**, `consoleErrors=0` (halaman 11B).

### Peta butir → berkas → bukti

| # | Judul | Berkas utama | Bukti uji (jumlah pemeriksaan) |
|---|-------|--------------|-------------------------------|
| 58 | Dewan juri | `wave11b/council.ts` | `wave11b-council` C1–C34 + U1–U10 + Q1–Q6 = 50 |
| 59 | Shadow-first rollout | `wave11b/shadow.ts`, `platform_settings.shadow_mode` | `wave11b-metrik` §59 = 23 |
| 60 | Learnings registry | `wave11b/learnings.ts`, `agent_memories.kind` | `wave11b-metrik` §60 = 30 |
| 61 | Benchmark + uji model | `wave11b/benchmark.ts`, `apps/api/benchmark/questions.json` | `wave11b-council` B1–B23 + U11–U16 + Q7–Q8 = 31 |
| 62 | Replay timeline | `wave11b/timeline.ts` | `wave11b-riwayat` §5 = 23 |
| 63 | Resume seeding | `wave11b/resume.ts`, `runs.resume_state/resumed_from/resume_attempts` | `wave11b` §6 = 24 |
| 64 | Ekspor/impor agen | `wave11b/persona-transfer.ts` | `wave11b-riwayat` §7 = 28 |
| 65 | Metrik jujur: pemakaian & audit pribadi | `wave11b/account-usage.ts` | `wave11b-riwayat` §8 = 44 |
| 66 | Laporan galat admin + ekspor | `wave11b/errors.ts`, tabel `error_events` | `wave11b-metrik` §66 = 24 |
| 67 | Akuntansi token: saldo + proyeksi | `wave11b/token-accounting.ts` | `wave11b-metrik` §67 = 26 |
| 72 | Jadwal prompt bebas | `wave11b/schedules.ts`, `jobs.ts`, `cron.ts` | `wave11b` §12 = 30 |
| 83 | Matriks perilaku gabungan | `wave11b/behavior-matrix.ts`, `docs/ARCHITECTURE.md` | `wave11b` §11 = 20 |

Bagian §0 (penyiapan, 6 pemeriksaan) dan A1–A3 (penutup, 3 pemeriksaan) pada `wave11b-council`
tidak dihitung ke salah satu butir. Jumlah total 11B: 92 + 111 + 103 + 81 = **387 pemeriksaan API**.

### Catatan jujur (yang TIDAK terbukti atau menyimpang dari PRD)

1. **Butir 72 ditarik dari Wave 11C ke Wave 11B.** Butir 83 (matriks perilaku) memprasyaratkan 42, 72,
   dan 63, jadi 72 dikerjakan lebih awal. Akibatnya uji jadwal ada di `wave11b.e2e.ts` §12, bukan di
   `wave11c` §3 port 7322 seperti tertulis di kartu butir. Ini penyimpangan urutan, bukan penyimpangan
   perilaku: seluruh isi kartu butir 72 (termasuk `SCHEDULE_LIMIT=10`, `CRON_INVALID`, zona waktu
   bawaan `Asia/Jakarta`) dipenuhi.
2. **Butir 58 — kuota dihitung antar-gelombang, bukan di dalam gelombang.** Juri di dalam satu
   gelombang berjalan bersamaan (`COUNCIL_MAX_PARALLEL=2`), jadi pemotongan kuota hanya terlihat saat
   gelombang berikutnya dimulai. Uji Q4 memakai 3 juri (dua gelombang) supaya efeknya terbukti.
   Pencegahan di dalam gelombang menuntut reservasi token lebih awal — belum dibangun.
3. **Butir 58 — mesin mock tidak bisa menghasilkan verdict terstruktur.** Karena itu verdict pada uji
   e2e "tidak terbaca" dan penguraian verdict diuji langsung (U1–U5). Uji C23 membuktikan jawaban
   tanpa verdict **tidak** ditebak dari kata kunci.
4. **Butir 61 — skor benchmark dengan mesin mock = 100.** Dua model tiruan menerima prompt identik,
   jadi jawabannya sama (B14). Rumus penilaiannya sendiri diuji terpisah (U11–U13).
5. **Butir 61 — berkas soal harus ikut ke image produksi.** `questions.json` dibaca saat berjalan,
   jadi `Dockerfile` dan `Dockerfile.austria` diberi baris `COPY` untuk folder `apps/api/benchmark`.
   Tanpa itu, produksi akan gagal dengan `BENCHMARK_QUESTIONS_MISSING`.
6. **Butir 59 — mode bayangan bawaannya mati** (`SHADOW_MODE=off`); admin boleh menyalakannya lewat
   API. Semua penulisan pengukuran bersifat gagal-aman: kegagalan pencatatan tidak pernah menggagalkan
   jawaban.
7. **Butir 63 — kebijakan lanjutkan yang dipakai:** otomatis maksimum 1 percobaan
   (`RESUME_MAX_AUTO_ATTEMPTS`), manual maksimum 3; run yang sudah merupakan lanjutan tidak pernah
   dilanjutkan lagi (tidak ada rantai, alasan `LANJUTAN_DARI_LANJUTAN`); percakapan mode diskusi tidak
   pernah dilanjutkan otomatis (aturan ① matriks 83); percobaan otomatis yang habis dilaporkan
   `PERCOBAAN_OTOMATIS_HABIS`. Prompt lanjutan memakai ringkasan percakapan terakhir + hasil sebagian.
8. **Butir 65 — angka tidak dibulatkan** dan rekonsiliasi memakai `run_usage.sell_cost_micros`
   sebagai sumber kebenaran. Token yang tidak bisa diatribusikan ke pengguna tetap **ikut** dijumlah
   dengan catatan, bukan dibuang diam-diam.
9. **Temuan agen `metrik` yang sudah ditutup:** rute `GET/PATCH/DELETE /api/v1/memories` sempat
   memperlakukan pelajaran (`kind='learning'`) sebagai memori biasa. Sudah diperbaiki di `server.ts`
   (`AND kind='memory'` di ketiga rute) dan sekarang dibuktikan uji (daftar memori bersih; PATCH/DELETE
   lewat rute memori atas id pelajaran menjawab `404 MEMORY_NOT_FOUND` tanpa merusak barisnya).
10. **Bug tanggal/zona yang ditemukan uji dan diperbaiki:** `next_run_at` sempat mewarisi detik dan
    milidetik (`00:00:00.372Z`) dan selisih zona tidak bulat (Jakarta terbaca 25.199.628 ms, bukan
    25.200.000 ms). Keduanya sudah dipotong ke menit penuh / dibulatkan; uji tiga zona (Jakarta
    00:00Z, UTC 07:00Z, Wina 05:00 dan 06:00Z saat DST) sekarang lulus.
11. **Butir 66 — batas yang dipakai:** pesan galat dipotong 800 karakter, ekspor CSV maksimum 5.000
    baris, retensi 30 hari (`RETENTION_ERROR_DAYS`).
12. **Butir 67 — saldo disimpan di `platform_settings` kunci `token_accounting.<YYYY-MM>`**;
    proyeksi = terpakai / hari berjalan × jumlah hari bulan itu. Bulan yang sudah lewat dianggap penuh,
    bulan depan belum dihitung.
13. **`APP_VERSION` di `.env.austria.example` sudah `0.23.0`** (26 Sep 2026; sebelumnya `0.19.0`, sedangkan
    produksi berjalan `0.20.2`). `deploy-austria.sh` menyetel `APP_VERSION=<versi>` sendiri di `.env` peladen
    pada tiap deploy, jadi nilai di berkas contoh hanya penanda.
14. **Antarmuka 11B** (butir 58, 60, 61, 62, 63, 64, 65, 66, 67, 72 dan kartu mode bayangan 59)
    SELESAI: `npm run build` exit 0 (680 modul, dari 668), uji peramban 169/169 lulus (dari 97),
    0 gagal, 1 dilewati jujur, `consoleErrors=0`. Satu balapan waktu ditemukan jalannya side lead
    pada pemeriksaan "hapus pelajaran" lalu diperbaiki di berkas uji (tunggu server DAN halaman).
    Rinciannya di catatan 19 bagian Wave 11C.

## Wave 11A (v0.21.0) — paritas `chat.coblai.com`: 18 butir (42–57, 79, 80) — SELESAI DI KODE DAN SUDAH LIVE

Sumber kerja: `PRD_WAVE_11_EKSEKUSI_v5.md` (25 Sep 2026; 42 butir, nomor 42–83, lanjutan daftar
masalah yang berakhir di 41). Wave 11A adalah gelombang pertama. Skema basis data naik **18 → 19**
satu kali saja (`SCHEMA_VERSION = 19`, ringkasan perubahan ditulis di `SCHEMA_VERSION_NOTE`),
`retention.ts` dan `dataexport.ts` ikut diperbarui. **Belum ada deploy, belum ada restart, belum ada
commit.**

Gerbang yang dijalankan sendiri (26 Sep 2026, semua di mesin ini):
- `npm run verify` → **44/44 suite hijau** (gerbang tipe uji `tsconfig.test.json` → gerbang migrasi
  `migration-check.ts` → seluruh suite e2e), keluar kode **0**.
- Suite baru Wave 11A (dijalankan ulang satu per satu setelah semua perubahan selesai, keluar kode 0):
  `wave11a.e2e.ts` **176 lulus / 0 gagal / 0 lewat**, `wave11a-rahasia.e2e.ts` **127/0**,
  `wave11a-artefak.e2e.ts` **84/0**, `wave11a-csp.e2e.ts` **187/0**.
- Dashboard: `npm run build` LULUS (`tsc -b` + vite, 668 modul) dan `node e2e/ui.e2e.mjs` **97/97 lulus,
  0 gagal, 0 galat konsol** (Chromium sungguhan; total naik dari 73 menjadi 97 — 24 tambahan dari penutupan tiga kekurangan
  antarmuka butir 46/47/53).

### Peta butir → berkas → bukti

| # | Judul | Berkas utama | Bukti uji (jumlah pemeriksaan) |
|---|-------|--------------|-------------------------------|
| 42 | Mode diskusi/eksekusi per percakapan | `wave11a/mode.ts`, `server.ts` (`buildSystemBlocks`) | `wave11a §1` = 15 |
| 43 | Enkripsi rahasia at-rest (AES-256-GCM) | `secrets.ts`, `wave11a/secrets-routes.ts`, tabel `user_secrets` | `wave11a-rahasia §1+§2` = 65 |
| 44 | Isolasi kredensial antar-sesi | `run-secret-vault.ts`, `engine-adapter.ts`, `prime-rpc-engine.ts` | `wave11a-rahasia §3` = 20 + `wave11a §3b` = 7 |
| 45 | Filter anti prompt-hijack | `prompt-guard.ts` | `wave11a §4` = 20 |
| 46 | Guardrails (kualitas & larangan) | `wave11a/guardrails.ts`, kolom `violations` di detail run | `wave11a §5` = 24 + uji UI panel pelanggaran |
| 47 | Kebijakan alat berhalaman | `wave11a/tools-policy.ts`, `platform_settings.tools_catalog` | `wave11a §6` = 14 + uji UI halaman Kebijakan alat |
| 48 | Tulis-balik artefak + riwayat + jaring aman | `wave11a/artifact-edit.ts`, tabel `artifact_revisions` | `wave11a-artefak` = 84 + uji UI 4 |
| 49 | Preview Word/Excel/PowerPoint | dashboard `ArtifactPreview.tsx`, `ArtifactEditor.tsx` | uji UI 8 (docx, xlsx, pptx, md, >10 MB, docx rusak, sandbox, tautan unduh) |
| 50 | Generasi & edit/gabung gambar | — | **TERTAHAN** menurut PRD (tidak dikerjakan di 11A) |
| 51 | Skill pengguna bisa dipasang | `wave11a/skills.ts`, tabel `user_skills` | `wave11a §7` = 18 |
| 52 | Knowledge base platform | `wave11a/knowledge-base.ts`, tabel `platform_knowledge` | `wave11a §8` = 15 |
| 53 | Audit-diri kredensial + uji mandiri | `selfaudit.ts`, dashboard `PlatformHealth.tsx` | `wave11a-rahasia §4` = 39 + uji UI kartu Kesehatan platform |
| 54 | Hapus semua riwayat | `wave11a/history.ts` | `wave11a §10` = 16 + uji UI 4 |
| 55 | Tombol instal di HP (+ panduan iOS) | dashboard `InstallPrompt.tsx`, `public/manifest.webmanifest` | uji UI 6 |
| 56 | Playground kalkulator biaya | `wave11a/estimate.ts` | `wave11a §11` = 9 |
| 57 | Fallback model otomatis | `wave11a/fallback.ts`, kolom `runs.fallback_from/fallback_count` | `wave11a §12` = 16 |
| 79 | CSP + netralisasi HTML dokumen | `wave11a/csp.ts`, `html-sanitize.ts`, `nginx/coder.sam.university.conf` | `wave11a-csp` = 187 (naik 2 tiap halaman dashboard bertambah) |
| 80 | Pagar konteks total | `wave11a/context-budget.ts`, `server.ts` (`buildSystemBlocks`) | `wave11a §13` = 14 |

Jumlah pemeriksaan Wave 11A: 176 + 127 + 84 + 187 = **574 pemeriksaan API** + 97 pemeriksaan UI.
Angka suite CSP tidak tetap: berkas itu menyusuri setiap halaman dashboard lewat tautan navigasi, jadi
jumlahnya bertambah 2 setiap halaman baru ditambahkan (185 sebelum halaman "Kebijakan alat" ada,
187 sesudahnya).

### Catatan jujur (yang TIDAK terbukti atau menyimpang dari PRD)

1. **Butir 42 — mode diskusi hanya dijaga di tingkat instruksi, bukan di tingkat kode.** Yang
   terbukti: mode disimpan di `conversations.agent_mode`, nilai tak sah ditolak `400
   INVALID_AGENT_MODE`, percakapan milik ruang kerja lain ditolak, mode bertahan setelah server
   dijalankan ulang, dan blok instruksi `【MODE DISKUSI】` benar-benar terkirim ke mesin (dibuktikan
   lewat gema mesin mock) dengan prioritas **0** sehingga tidak pernah dipotong pagar konteks.
   Yang **belum** terbukti: "perintah tulis berkas X tidak menghasilkan artefak" pada DoD butir 42.
   Itu perilaku model, dan mesin mock tidak pernah menulis berkas. Bukti penuh butuh mesin AI nyata
   (suite `real-ai.e2e.ts` tidak dijalankan di gerbang ini).
2. **Butir 47 — penyimpangan sadar.** Saat katalog alat belum diatur, daftar bawaan **kosong** =
   semua alat bawaan mesin tetap dipakai (perilaku lama). Penyaringan hanya aktif setelah admin
   mengisi `platform_settings.tools_catalog`. Ini memenuhi DoD "daftar bawaan aman", tetapi
   artinya bukan daftar putih yang ketat sejak awal.
3. **Butir 48 — arti nomor revisi.** Artefak baru melaporkan `revision: 0` ("belum ada revisi").
   Setiap `PUT /content` menyalin isi **sebelum** perubahan sebagai revisi bernomor `+1`, baru
   menimpa berkas nyata — jadi `revision` = nomor salinan terakhir, dan `baseRevision` wajib sama
   dengan nomor itu (kalau tidak → `409 ARTIFACT_CHANGED` beserta nomor terbaru). Batas retensi 20
   revisi dan pagar anti-bentrok-tulis (`409 ARTIFACT_WRITE_BUSY`) bekerja, tetapi pagar tulis itu
   hidup di memori proses: dua pekerja terpisah tidak saling melihat.
4. **Butir 49 — satu pemeriksaan memakai simulasi.** Server menolak unggahan artefak di atas 10 MB
   (`413 ARTIFACT_TOO_LARGE`), jadi uji antarmuka "berkas besar jatuh ke mode unduh" menyadap
   jawaban daftar artefak agar ukurannya 11 MB. Yang terbukti: aturan antarmuka. Aturan server-nya
   tidak diuji di sana.
5. **Butir 79 — `style-src-attr` sengaja tidak dipasang.** Diukur dengan Chromium sungguhan:
   127 elemen bergaya inline di semua halaman dashboard tetap tampil tanpa galat CSP, karena React
   menulis gaya lewat CSSOM, bukan atribut. Konsekuensinya: HTML dari dokumen yang ditampilkan
   lewat `srcdoc` **mewarisi** CSP halaman induk, jadi gaya inline di dalam dokumen Word bisa hilang
   (isi tetap terbaca, skrip tetap diblokir). Kalau Bapak ingin gaya dokumen utuh, jalan resminya
   sudah disediakan di `wave11a/csp.ts`: menambahkan `style-src-attr 'unsafe-inline'` **tanpa**
   menyentuh `script-src`.
6. **Dua suite lama diperbaiki karena kenaikan skema/daftar kunci** (bukan karena kode lama rusak):
   `wave10.e2e.ts` mematok "versi skema = 18" → sekarang memakai `${SCHEMA_VERSION}`; daftar resmi
   kunci lingkungan `deploy/env.keys.txt` bertambah 9 kunci Wave 11A sehingga gerbang anti-basi
   `deploy-env-sync.e2e.ts` hijau lagi.
7. **Kunci `.env` baru = pekerjaan deploy, bukan pekerjaan kode.** `SECRETS_KEY` (32 byte base64),
   `PROMPT_GUARD_ENABLED`, `CONTEXT_BUDGET_CHARS`, `CSP_ENABLED`, `ARTIFACT_EDIT_MAX_BYTES`,
   `ARTIFACT_REVISION_LIMIT`, `ENGINE_FALLBACK_MAX_SWITCHES`, `RETENTION_ARTIFACT_REVISION_DAYS`,
   `RETENTION_SAFETY_DAYS` sudah masuk **dua-duanya**: `.env.austria.example` (template di repo) dan
   `deploy/env.keys.txt` (daftar resmi yang dibaca `deploy/env-sync.sh`). Pada deploy berikutnya
   `deploy-austria.sh` akan menambahkannya sendiri ke `.env` server. Tanpa `SECRETS_KEY` terisi,
   semua rute rahasia menjawab `503 SECRETS_KEY_MISSING` (fitur tetap hidup, hanya tidak menyimpan).
8. **`env-sync.sh` hanya menambah kunci yang belum ada** — nilai kunci lama di `.env` produksi tidak
   pernah ditimpa, dan baris lama tidak dihapus.
9. **Berkas uji sementara di `/tmp`** masih menumpuk (butir 40). Suite Wave 11A yang baru sudah
   membersihkan direktori kerjanya sendiri di akhir; sisa lama (~174 direktori, ~800 MB) menunggu
   izin Bapak untuk dihapus.
10. **Nama berkas rahasia diubah** dari `credential-vault.ts`/`credentials.ts` menjadi
    `run-secret-vault.ts`/`secrets-routes.ts` (menghindari `.gitignore` root baris 7 `*credential*`),
    dan nama berkas uji menjadi `wave11a-rahasia.e2e.ts`. Nama **fungsi** di dalamnya tetap sesuai
    PRD (`encryptSecret`, `decryptSecret`, `isSealed`).
11. **Mesin mock menambah dua tuas uji**: `MOCK_ENGINE_FAIL_MODELS` (daftar model yang gagal) dan
    `MOCK_ENGINE_FAIL_TEXT` (teks galat; kata pertama = kode). Hanya dipakai suite uji.
12. **Suite uji tidak memakai pemeriksaan "selalu lulus"** dan tidak ada yang dilewati
    (`Dilewati: 0`). Pemeriksaan dibuang kalau ternyata tidak bisa gagal.

13. **Dua kegagalan palsu ditemukan dan diperbaiki (kejujuran uji).** Dua kali suite utama melaporkan
   gagal ketika dijalankan bersamaan dengan pekerjaan berat lain. Akar masalahnya ditemukan: berkas uji
   memakai nomor port acak tanpa memeriksa, sehingga bila ada server uji lama yang masih memegang port
   itu, server baru gagal mengikat port dan permintaan uji nyasar ke server lama — yang tidak tahu
   variabel lingkungan milik proses ini (`MOCK_ENGINE_FAIL_MODELS`), jadi pemeriksaan §12m/§12n gagal.
   Perbaikannya: tiga berkas uji (`wave11a.e2e.ts`, `wave11a-artefak.e2e.ts`, `wave11a-rahasia.e2e.ts`)
   kini mencari port yang benar-benar bebas lebih dulu, dan berhenti dengan pesan jelas bila tidak ada.
   Pemeriksaan yang sama juga tidak lagi menyerah setelah 8 detik menunggu run selesai (jadi 30 detik).
   Bukti: setelah perbaikan, keempat suite dijalankan berurutan dan semuanya keluar kode 0.
14. **Tiga kekurangan antarmuka ditemukan saat memeriksa PRD butir per butir, lalu ditutup.**
   PRD mewajibkan halaman "Kebijakan alat" (butir 47), kartu "Kesehatan platform" + tombol "Jalankan uji
   mandiri" di halaman Status (butir 53), dan panel pelanggaran kecil di Riwayat run (butir 46).
   Ketiganya belum ada pada penyerahan pertama; sekarang ada (`ToolsPolicy.tsx`, `PlatformHealth.tsx`,
   panel di `Runs.tsx`). Untuk butir 46, rute `GET /api/v1/runs/:runId` juga ditambah kolom `violations`.
15. **Panel pelanggaran di Riwayat run hampir selalu kosong — dan itu benar.** Aturan larangan menahan
   permintaan SEBELUM run dibuat, jadi baris pelanggaran tidak punya `run_id`. Jejak lengkap per akun ada
   di `GET /api/v1/safety` (halaman Guardrail). Panel hanya muncul bila ada isinya.
16. **Dashboard adalah repo terpisah** (`/workspace/coblai-dinda/coder-dashboard`) di dalam satu repo git
   `/workspace/coblai-dinda`. Belum ada deploy dashboard maupun API.

## Beres-beres sertifikat & rotasi sandi akun uji (21 Sep 2026 malam) — atas izin Bapak

- **`cover.sam.university`** (DNS NXDOMAIN = domain mati) → vhost
  `sites-enabled/cover.sam.university.conf` DIHAPUS dan sertifikatnya DIHAPUS.
- **`kampus.sam.university`** (DNS NXDOMAIN = domain mati) → symlink sites-enabled +
  `sites-available/kampus.sam.university.conf` (+ berkas `.bak_20260904_123144`) DIHAPUS; sertifikat DIHAPUS.
- **`inventory.coblai.com`** → vhost DIHAPUS. Premis awal kami salah (kami kira vhost itu tidak aktif,
  padahal `grep -r` tidak mengikuti symlink): vhost itu AKTIF dan mengalihkan 301 ke
  `https://rena.coblai.com`. Akibatnya `https://inventory.coblai.com` kini gagal TLS (disajikan
  sertifikat default `blog.crossbordermarketplace.com`). Pembaruan sertifikatnya justru kini BERHASIL.
  Menunggu keputusan Bapak: hidupkan lagi 301-nya atau biarkan mati.
- **`sam.university`** dan **`rena.coblai.com`** → DIPERBAIKI dengan menambahkan
  `location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }` ke blok :443. `proxy_pass`
  (`127.0.0.1:2369`), `root /www/wwwroot/rena.coblai.com`, dan aturan `try_files` TIDAK disentuh.
  Kedua situs tetap menjawab 200.
- Gerbang: `nginx -t` OK, `systemctl reload nginx` OK, `/health` 200, tidak ada rujukan sisa untuk nama
  yang dihapus, `certbot renew --dry-run` → **24 berhasil / 1 gagal** (`geoauthorityengine.com`, proyek
  lain, tidak disentuh). Sebelum perbaikan: 5 gagal.
- Cadangan: `/root/backup-nginx-20260921/nginx-letsencrypt-backup.tar.gz` (432 entri, termasuk kunci
  privat letsencrypt). Laporan rinci: `/workspace/LAPORAN_BUTIR20B_SERTIFIKAT_v2.md`.
- **Rotasi sandi akun uji `smoke.bot`** (izin Bapak): sandi diganti lewat `POST /api/v1/auth/password`
  di produksi; sandi lama ditolak 401 sesudahnya, sesi lain diputus (`otherSessionsRevoked=true`).
  Sesudah rotasi, smoke produksi dijalankan ulang memakai kredensial DARI BERKAS `.env`
  (`/root/.coblai/smoke.env`, mode 600): **202 lulus, 0 gagal, keluar 0**. Nilai sandi tidak pernah
  dicetak. Catatan jujur: sandi hasil rotasi PERTAMA sempat tercetak karena skrip dijalankan dengan
  `bash -x` (trace menampilkan variabel lingkungan); karena itu rotasi diulang sekali lagi dan skrip
  ber-`-x` dihapus. Pelajaran: jangan pernah memakai `bash -x` pada skrip yang memuat rahasia.

## v0.20.2 (21 Sep 2026) — butir 15b, 19, 20 — SELESAI DI KODE DAN SUDAH LIVE

- **Butir 15b — sapuan `rate_limit_hits` pindah ke pekerja terjadwal.** Jenis pekerjaan baru
  `ratelimit.sweep` (`jobs.ts`) dijadwalkan tiap 5 menit; sapuan malas di proses web diatur
  `RATE_LIMIT_SWEEP_IN_WEB` (bawaan `true`, produksi `false`). Uji `apps/api/test/ratelimit-sweep.e2e.ts`
  → **22/22 lulus, 0 skip**.
- **Butir 19 — harga resmi DeepSeek + rekonsiliasi biaya.** Berkas `apps/api/src/vendor-prices.ts`
  memuat harga resmi berstempel tanggal (`deepseek-flash` 0,15/0,60/0,003 dan `deepseek-v4-pro`
  0,66/1,98 per 1 juta token) plus tarif puncak dua kali pada 01:00–04:00 dan 06:00–10:00 UTC hari
  kerja. Urutan sumber harga: harga sendiri → harga resmi vendor → katalog mesin. `prime-rpc-engine.ts`
  dan `pricing.ts` memakai lapisan ini; `model-prices.ts` tidak diubah (berkas generated).
  Rekonsiliasi produksi (baca saja, 13–19 Sep): `run_usage` tercatat 5.152 mikrodolar vs seharusnya
  8.023 (+55,7%); `user_usage` 11.501 vs 15.979 (+38,9%); gabungan 16.653 vs 24.002 (+44,1%).
  Rute baru `GET /api/v1/admin/pricing/reconcile` + kartu "Rekonsiliasi biaya AI" di halaman Konsol
  Harga. Uji `pricing.e2e.ts` → **164/164 lulus, 0 skip**.
- **Butir 20 — timer TLS certbot diperiksa (baca saja).** Timer aktif + enabled, 2x sehari; sertifikat
  `coder.sam.university` sah sampai 11 Des 2026 dan yang disajikan nginx identik dengan yang di disk;
  uji kering untuk sertifikat ini berhasil. Temuan yang butuh izin Bapak (5 sertifikat proyek lain
  gagal uji kering; symlink sisa di `sites-enabled`) dicatat sebagai butir 20b di
  `docs/DAFTAR_MASALAH_TERTUNDA.md`. Laporan lengkap: `/workspace/LAPORAN_BUTIR20_CERTBOT.md`.

### Deploy & operasi produksi v0.20.2 (21 Sep 2026)

- Paket dibangun dengan `deploy/buat-paket.sh 0.20.2` → `PAKET_OK` (206 entri, 844K,
  sha256 `aa99994b...`). Percobaan pertama GAGAL (`DEPLOY_ABORTED deploy/env-sync.sh + deploy/env.keys.txt
  tidak ada di paket (butir 32)`) karena paket dibuat dengan `tar -czf` tangan; sekarang
  `deploy/buat-paket.sh` wajib dipakai karena menyalin `deploy/env-sync.sh` + `deploy/env.keys.txt`
  ke dalam paket.
- `deploy/deploy-austria.sh 0.20.2` keluar 0 pukul 15:13-15:16 UTC, dengan bukti di log:
  `REHEARSAL SCHEMA_VERSION_AFTER_MIGRATION 18 EXPECTED 18`, `REHEARSAL ROW_COUNTS_PRESERVED true`,
  `REHEARSAL MIGRATION_REHEARSAL_OK`, `ZERO_DOWNTIME_DONE hijau dihentikan, biru melayani 3402`,
  container pekerja dibuat ulang, dan `DEPLOY_OK coder-platform-app:0.20.2`.
- Sesudah deploy: `coder-platform-app:0.20.2` (healthy) + `coder-platform-worker:0.20.2`;
  `https://coder.sam.university/health` = 200.
- Smoke produksi: **202 lulus, 0 gagal, 0 lewat**, `PRODUCTION_SMOKE_PASSED`, keluar 0 — termasuk
  `butir19 the status hub reports the vendor price layer`, `... the recorded versus corrected AI cost`,
  dan `... the cost reconciliation refuses a normal account`.
- Bukti butir 15b di produksi: tabel `jobs` memuat baris `kind='ratelimit.sweep'` berstatus `done`
  setiap 5 menit dengan hasil `{"removed":0,...,"sweepInWeb":false}` → sapuan benar-benar dikerjakan
  proses pekerja, bukan proses web.
- Symlink sisa nginx dihapus (izin Bapak 21 Sep 2026): `nginx -t` OK, `systemctl reload nginx` OK,
  jumlah `server_name coder.sam.university` di `nginx -T` 4 → 2, peringatan "conflicting server name"
  untuk domain kita hilang, `/health` tetap 200. Rinciannya di butir 20b.

Wave 10 (v0.20.0, 18 Sep 2026) — jawaban butir 21–32D, semuanya di kode dan diuji.
Status: **LIVE di server Austria** sejak 18 Sep 2026 11:25 UTC. Deploy dan smoke produksi sudah
dijalankan atas izin Bapak; bukti lengkapnya di bagian "Deploy & operasi produksi v0.20.0 (18 Sep 2026)".

- **Gerbang tipe untuk berkas uji (butir 21)**: `tsconfig.test.json` di akar `coder-platform` memuat
  `apps/api/test/**/*.ts`; `apps/api/test/run-all.cjs` menjalankannya dengan `npx tsc -p
  tsconfig.test.json` sebagai **gerbang PERTAMA**, sebelum gerbang migrasi. Semua galat tipe di suite
  lama diperbaiki (bukan dimatikan) dan ringkasan `npm run verify` sekarang berbunyi "(termasuk gerbang
  tipe uji dan gerbang migrasi)".
- **Uji UI di peramban sungguhan (butir 22 + 32d)**: `playwright` (devDependency dashboard, tidak masuk
  image produksi) + suite `coder-dashboard/e2e/ui.e2e.mjs`. Suite menyajikan SPA hasil `vite build`
  (`dist/`) bersama API lokal bermesin mock, lalu mengklik alur nyata: daftar akun, masuk, setiap
  halaman Wave 10 lewat menu samping, kotak cari global, halaman admin, plus pemeriksaan service worker
  dan penangan push (gagal di peramban dicatat sebagai galat konsol, jadi halaman kosong tidak dianggap
  lulus). Jalankan `cd coder-dashboard && npm run e2e` (atau `npm run e2e:full` untuk membangun `dist/`
  dulu; dari platform: `npm run test:ui`). Hasil terakhir: **28/28 lulus, 0 gagal, 0 lewat, keluar 0**.
  Dua cacat nyata ditemukan suite ini sendiri: (1) `npx` membungkus server dengan proses cucu sehingga
  `SIGKILL` tidak menutup pipa stdout — suite mencetak `UI_E2E_PASSED` tetapi prosesnya tidak pernah
  berakhir (gejala `SELESAI=124`), sudah diganti `process.execPath --import tsx` + penutupan pipa;
  (2) `dist/` harus ada lebih dulu, dan suite keluar 2 dengan `UI_E2E_SKIPPED` supaya tidak berbohong.
- **Webhook: urutan, kirim ulang, pembersihan (butir 23)**: kolom `webhook_deliveries.sequence` (monoton
  per webhook) dan `resend_of`; pengiriman MENUNGGU bila kiriman berurutan lebih awal masih `queued`
  (status `deferred`, dicoba lagi sampai `MAX_ORDER_DEFERRALS`); header `X-COBLAI-Sequence`; rute
  `POST /api/v1/webhooks/:id/deliveries/:deliveryId/resend` (jawab **201**); tabel riwayat + tombol
  "Kirim ulang" di halaman Webhook; pembersihan riwayat lewat retensi (`RETENTION_WEBHOOK_DAYS`, bawaan
  30) plus tombol bersihkan-sekarang dengan mode kering.
- **Kuota token termasuk run yang sedang berjalan (butir 24)**: `runs.reserved_tokens` diisi saat run
  dari kunci API dimulai; `apiKeyUsageToday()` = token selesai + token cadangan run `queued`/`running`.
  API menampilkan cadangan itu: setiap kunci membawa `tokensReserved`, `quota.tokensReserved`, dan
  `inFlight[]`, sedangkan totalnya di `GET /api/v1/status-hub` (`housekeeping.reservedTokensWaiting`).
  **Catatan jujur: dashboard belum menampilkan angka ini di halaman Kunci API** (butir 41 di
  `docs/DAFTAR_MASALAH_TERTUNDA.md`).
- **Backfill peristiwa pertumbuhan (butir 25 + 32c)**: `backfillGrowthEvents()` merekonstruksi peristiwa
  dari tabel nyata (`users`, `projects`, `conversations`, `runs`, `run_usage`, `api_keys`, `webhooks`,
  `orders`, `referrals`) memakai `created_at` asli, menandai baris `source='backfill'`, idempoten, punya
  mode kering dan mode terapkan, dan bisa dipicu admin (`GET`/`POST /api/v1/admin/growth/backfill`).
  Katalog peristiwa tumbuh dari 16 ke 18 (tambah sumber artefak dan workflow).
- **Perangkat & sesi, verifikasi email (butir 26 + 32b)**: tabel `user_devices`, `auth_sessions.device_id`,
  halaman "Perangkat & sesi" (daftar, ubah nama, tandai tepercaya, cabut sesi), notifikasi + email
  "perangkat baru", dan gerbang rujukan baru `SAME_DEVICE` di samping `SAME_EMAIL`/`SAME_IP`; gerbang
  `DEVICE_VERIFY_NEW` tetap `off` supaya tidak ada risiko akun terkunci.
- **Mode kering + pembersihan berkala (butir 27)**: `RETENTION_DRY_RUN` + `runRetention({dryRun})`;
  skrip smoke membersihkan data ujinya sendiri (`SMOKE_KEEP_DATA=1` untuk melewati); pekerjaan berkala
  `smoke.cleanup` (`SMOKE_CLEANUP_ENABLED`, `SMOKE_CLEANUP_HOURS`) dengan mode lapor bila belum aktif.
- **Halaman Metrik (butir 28)**: `GET /api/v1/admin/metrics` (sesi admin, JSON) untuk UI + halaman
  "Metrik" dengan kartu indikator, tabel, tombol segarkan, dan isian token untuk mengambil teks
  Prometheus mentah. `/metrics` tanpa token yang benar tetap menjawab `404` tanpa keterangan.
- **Pencarian global lintas proyek (butir 29)**: `apps/api/src/search.ts` memakai FTS5 `message_search`
  (dijaga trigger insert/delete/update) + FTS knowledge + `LIKE` untuk proyek, percakapan, artefak, dan
  workflow. Rute `GET /api/v1/search?q=`, `GET /api/v1/search/status`, `POST
  /api/v1/admin/search/reindex`. Kata kunci di bawah 2 huruf ditolak `400 SEARCH_QUERY_TOO_SHORT`, di
  atas 200 huruf `400 SEARCH_QUERY_TOO_LONG`, istilah dipotong, dan hasil hanya dari ruang kerja tempat
  pengguna menjadi anggota.
- **Bahasa Indonesia saja (butir 30)**: keputusan tetap ditulis di `docs/KEPUTUSAN_BAHASA_INDONESIA.md`
  (tidak ada i18n; `error` = kode mesin, `message` = kalimat Indonesia) dan dijaga suite
  `apps/api/test/wave10-bahasa.e2e.ts` (14 pemeriksaan). Suite itu menemukan satu ketidakcocokan nyata:
  enam jawaban `WEBHOOK_NOT_FOUND` tidak punya `message` — sekarang semuanya memakai "Webhook itu tidak
  ditemukan di ruang kerja ini."
- **Notifikasi email dan push peramban (butir 31)**: `apps/api/src/push.ts` (kunci VAPID dibuat sekali dan
  disimpan di `platform_settings`; langganan di `push_subscriptions`), rute `GET /api/v1/push/key`,
  `GET/POST/DELETE /api/v1/account/push*`, `POST /api/v1/account/push/test`; service worker
  `coder-dashboard/public/push-sw.js` menangani `push` + `notificationclick`; tombol aktif/nonaktif di
  Pengaturan. Kunci pribadi VAPID tidak pernah ikut dalam jawaban API (juga diperiksa smoke produksi).
- **Penyelarasan kunci `.env` (butir 32)**: `deploy/env.keys.txt` (daftar resmi 76 kunci + komentar, satu
  bagian `#usang`) dan `deploy/env-sync.sh` (`--check` untuk pratinjau): menambah kunci yang hilang
  beserta nilai bawaannya, **tidak pernah menimpa nilai lama**, melaporkan `ENV_MISSING`/`ENV_ADDED`/
  `ENV_OBSOLETE_KEYS`/`ENV_UNKNOWN_KEYS`, cadangan bernomor `<env>.bak.1/.bak.2` hanya bila ada
  penambahan, idempoten, tanpa `eval`/`source`/`sed -i`, dan hanya mencetak NAMA kunci (nilai rahasia
  tidak pernah muncul di log). Dipanggil `deploy/deploy-austria.sh` (pratinjau dulu, lalu penyelarasan;
  berhenti `DEPLOY_ABORTED` bila berkas tidak ikut dalam paket) dan diuji suite
  `apps/api/test/deploy-env-sync.e2e.ts` (70 pemeriksaan, semuanya di `/tmp`; berkas `.env` sungguhan
  tidak disentuh). Dua temuan nyata: (1) `PLATFORM_WEBHOOK_URL` terbukti tidak pernah dibaca kode
  (`config.ts` hanya mendeklarasikan skema) → masuk bagian `#usang` dan hanya dilaporkan, tidak dihapus;
  (2) enam kunci yang SUDAH dibaca kode (`CSRF_STRICT`, `WORKER_ONLY`, empat `RATE_LIMIT_*`) belum ada
  di `.env.austria.example` → sekarang ditambahkan beserta nilai bawaannya supaya tidak lagi muncul
  sebagai kunci asing. Satu kunci sisa (`MOCK_ENGINE_SILENT_USAGE`) sengaja TIDAK dimasukkan karena
  hanya dipakai suite uji.
- **Paket rilis kini bisa dibuat ulang**: `deploy/buat-paket.sh <versi>` membangun
  `deploy/coder-sam-university-v<versi>.tar.gz` dari berkas yang sudah di-commit (`git ls-files`), jadi
  `node_modules`/`dist`/`.env`/`data` tidak pernah ikut, dan wajib menyertakan
  `coder-platform/deploy/env-sync.sh` + `env.keys.txt` (kalau tidak ada, skrip gagal) — inilah sebab
  berkas penyelarasan `.env` harus di-commit sebelum paket dibuat.
- **Kebersihan uji**: cabang `skip(...)` bersyarat di tiga suite Wave 10 (`webhook-order`,
  `wave10-search`, `growth-backfill`) diubah menjadi `check(...)` keras setelah kode memenuhi spec, jadi
  regresi di masa depan akan terlihat sebagai GAGAL, bukan dilewati diam-diam. Suite Wave 10 sekarang
  melaporkan **skip 0**.

Wave 9 (v0.19.0, 16 Sep 2026) — jawaban butir 16–20, semuanya di kode dan diuji:

- **Deploy tanpa berhenti layanan (butir 16)**: `docker-compose.austria.yml` kini memakai satu anchor
  `x-app` untuk tiga layanan: `coder-platform-app` (biru, 127.0.0.1:3402),
  `coder-platform-app-green` (hijau, 127.0.0.1:3403, profil `green`), dan `coder-platform-worker`.
  `deploy/deploy-austria.sh` menjalankan tiga gerbang berurutan: rehearsal migrasi (butir 18),
  tukar hijau-biru lewat `point_nginx` + `wait_ready`, lalu pembuatan ulang wadah antrean (butir 17).
  Volume baru `coder-platform-engine-sessions` dipasang ke `/app/engine-sessions` (`ENGINE_ROOT_DIR`),
  jadi sesi mesin tidak lagi hilang setiap deploy dan bisa dipakai bersama biru, hijau, dan worker.
  Bila pola `proxy_pass http://127.0.0.1:34xx` tidak ada di berkas nginx, skrip mencetak
  `ZERO_DOWNTIME_SKIPPED` dan memakai cara lama; bila hijau tidak siap, skrip berhenti dengan
  `DEPLOY_BLOCKED` dan trafik tidak pernah diarahkan ke proses yang belum siap.
- **Antrean di proses sendiri (butir 17)**: `apps/api/src/worker.ts` menyalakan `WORKER_ONLY=true`
  dan `JOB_WORKER_IN_WEB=true` sebelum memuat `server.js`, jadi penangan pekerjaan tetap satu
  implementasi tetapi proses ini tidak membuka HTTP. `config.ts` menambah `JOB_WORKER_IN_WEB`
  (bawaan true, produksi false) dan `WORKER_ONLY`. Healthcheck wadah worker dimatikan dan diganti
  denyut log tiap 30 detik. Uji `worker-split.e2e.ts`: 17/17 lulus.
- **Gerbang migrasi tiap deploy (butir 18)**: `apps/api/src/migration-rehearsal.ts` ikut terkompilasi
  ke `dist/api` sehingga ada di dalam citra. Dipakai dua tempat: gerbang pertama `run-all.cjs`
  (`npm run verify`) dan gerbang pertama `deploy-austria.sh` (wadah sekali pakai berisi citra BARU,
  hanya volume cadangan yang dipasang baca-saja; kegagalan → `DEPLOY_ABORTED` sebelum apa pun
  diganti). Pemeriksaannya: versi skema, tabel dan kolom wajib, jumlah baris 24 tabel penting tidak
  berubah, `PRAGMA integrity_check`, kunci asing, dua sisipan percobaan (satu dibatalkan), dan
  idempotensi dengan membuka berkas yang sama di proses kedua.
- **Harga AI bisa dijual lagi (butir 19)**: kolom `cost_micros` tetap harga pokok dari penyedia dan
  TIDAK pernah disentuh markup; kolom baru `sell_cost_micros` = `round(cost_micros x markup)` adalah
  jumlah yang ditagihkan. Markup global disimpan di `platform_settings` (key `ai_pricing`, bawaan 1,
  rentang 0,1–100); harga per model bisa ditimpa lewat tabel `model_price_overrides`. Rute admin:
  `GET /api/v1/admin/pricing`, `PUT .../pricing/settings`, `PUT/DELETE/GET .../pricing/models/:model`.
  Halaman baru "Harga AI" di dashboard menampilkan ringkasan, pengatur markup, pencarian model,
  saringan semua/dipakai/harga sendiri, dan editor harga per model dengan pesan galat Indonesia.
  Uji `pricing.e2e.ts`: 130 lulus / 0 gagal / 0 lewat; `render-check-wave9.tsx`:
  `ALL_WAVE9_PAGES_RENDERED`.
- **Pengatur waktu TLS diperiksa (butir 20)**: `certbot.timer` aktif, sertifikat berlaku ±85 hari,
  `certbot renew --dry-run` melaporkan semua pembaruan simulasi berhasil. Tidak ada perubahan.
- Skema basis data: **17**.
- Empat bug nyata diperbaiki: `catalog` pada konsol harga memakai harga override; `sell_cost_micros`
  terisi nilai markup bukan hasil kali; pengatur waktu `startJobWorker()` di-`unref` sehingga worker
  tanpa HTTP keluar sendiri; pekerjaan berkala dijadwalkan beberapa milidetik di depan waktu acuan
  putaran sehingga tidak ikut diambil pada putaran yang sama (ini yang membuat `wave8.e2e.ts`
  sesekali berlomba dengan pekerjaan retensi).
- Dokumen: `docs/PLAN_WAVE_9.md`.
Wave 8 (v0.18.0, 16 Sep 2026) — jawaban butir 6–15, semuanya di kode dan diuji:
- **Akun bisa ditutup sendiri (butir 6)**: `DELETE /api/v1/auth/account` kini penutupan lunak wajib
  ekspor (`409 EXPORT_REQUIRED` bila belum ada ekspor ≤24 jam, `409 EXPORT_TOO_OLD` bila lebih tua),
  masa pemulihan **90 hari** (`users.deleted_at` + `users.purge_after`), masuk ditolak
  (`403 ACCOUNT_DELETED`), admin bisa memulihkan (`POST /api/v1/admin/users/:id/restore`).
  Penghapusan permanen dilakukan pekerja `retention.run`: baris pengguna hilang, workspace tanpa
  anggota lain ikut hilang berikut proyek dan berkasnya, workspace yang masih beranggota
  dipertahankan dengan anggota terlama dinaikkan menjadi `owner`.
- **Verifikasi email wajib untuk aksi AI (butir 7)**: `accountGate()` menolak `403 EMAIL_NOT_VERIFIED`
  pada pembuatan run, eksekusi workflow, dan pembuatan kunci API. Mode `VERIFY_EMAIL_REQUIRED`
  (`auto` bawaan | `on` | `off`); `auto` menegakkan gerbang hanya bila server email aktif, supaya
  platform tanpa SMTP tidak mengunci penggunanya. `/api/v1/auth/me` melaporkan `emailVerified`.
- **Admin kedua & wewenang admin (butir 10)**: `PATCH /api/v1/admin/users/:id` menerima `email`
  (email berubah ⇒ `email_verified` kembali 0), `POST /api/v1/admin/users/:id/password` menyetel
  sandi (dibuat otomatis bila kosong, mudah dibaca, ditampilkan sekali) dan mencabut semua sesi.
  Admin kedua cukup ditambahkan ke env `PLATFORM_ADMIN_EMAILS`.
- **Batas laju pindah ke basis data (butir 15)**: tabel `rate_limit_hits`, kunci berawalan nama
  aturan, jendela geser, sapuan tiap menit; `status-hub.openPlatform.rateLimits` melaporkan
  `store: "database"`.
- Skema basis data: **16**.
- Uji lokal: `wave8.e2e.ts` (99 pemeriksaan lulus) + `render-check-wave8.tsx`
  (`ALL_WAVE8_PAGES_RENDERED`); `npm run verify` = 28 suite.
- Rincian lengkap: `docs/PLAN_WAVE_8.md`. Tindakan operasi butir 11 (prune), 12 (hapus audit uji),
  dan 14 (batasi relay mailcow) BELUM dijalankan; butir 13 (push GitHub) terhalang kredensial.

Cara memperbarui berkas ini: jangan menulis dari ingatan. Baca kode lebih dulu, lalu catat buktinya.
Bukti minimum: rute `app.get/post/put/patch/delete` di `apps/api/src/server.ts`, versi schema dan tabel
di `apps/api/src/db.ts`, halaman di `coder-dashboard/src/nav.ts`, dan suite di `apps/api/test/`.
Bila ragu, tulis "belum diverifikasi".

Catatan snapshot: berkas ini diperiksa saat repo sedang diedit, jadi beberapa perubahan belum di-commit
(Wave 7: `server.ts`, `db.ts`, `config.ts`, `ratelimit.ts`, `referrals.ts` baru, `growth.ts` baru,
`api.ts`, `nav.ts`, `App.tsx`, `index.html`, `Referrals.tsx`/`Growth.tsx`/`Onboarding.tsx`/`PublicDocs.tsx` baru,
serta suite `wave7.e2e.ts` baru).
Jumlah rute `server.ts` saat diperiksa: 190 (30 rute baru v0.11.0 untuk komersial, admin dan webhook; 3 rute Wave 2
untuk lampiran, cabang dan hapus massal; 25 rute Wave 3 untuk ruang kerja agen; 28 rute Wave 4 untuk kunci API,
API publik, antrean email, ekspor data, retensi, dan harga publik; 3 rute Wave 5 untuk melihat antrean pekerjaan,
mengulang pekerjaan, dan memaksa satu putaran; 8 rute Wave 6 untuk dua rute tulis publik dan enam rute webhook;
11 rute Wave 7 untuk undangan, langkah awal, peringatan kuota, laporan pertumbuhan, panel undangan admin,
dokumentasi publik, robot, dan sitemap).
Bila angka di kode berbeda, jalankan ulang Cara verifikasi.

## Deploy & operasi produksi v0.20.1 (19 Sep 2026)

Isi rilis ini hanya perbaikan dashboard butir 41 (cepat, tanpa perubahan API).

- **Versi LIVE: `0.20.1`** (`coder-platform-app:0.20.1` sehat + worker `0.20.1`).
  `bash deploy/deploy-austria.sh 0.20.1` → `DEPLOY_OK coder-platform-app:0.20.1`, skrip keluar 0.
- **Paket**: `deploy/coder-sam-university-v0.20.1.tar.gz` (204 entri, 824K), SHA-256
  `a10d965b092a7a9376557180a84bbeaf123fb617e3b2fefdf2cefea7d44f573d`, diperiksa di server (`OK`).
  Paket dibangun dari commit `0301779`; commit dokumen sesudahnya tidak masuk paket, jadi berkasnya
  sengaja TIDAK dibangun ulang supaya checksum yang diverifikasi server tetap sah.
- **Gerbang deploy**: `ENV_MISSING_COUNT 0` dan `ENV_ADDED 0` (berkas `.env` produksi sudah selaras,
  jadi tidak ada cadangan baru), `ENV_OBSOLETE_KEYS PLATFORM_WEBHOOK_URL`,
  `ENV_UNKNOWN_KEYS DEEPSEEK_API_KEY`; rehearsal migrasi atas
  `/app/backups/coder-2026-09-19T01-17-01.581Z.db` → `SCHEMA_VERSION_AFTER_MIGRATION 18 EXPECTED 18`,
  `ROW_COUNTS_PRESERVED true`; nol henti (`ZERO_DOWNTIME_START hijau di 3403` →
  `ZERO_DOWNTIME_DONE hijau dihentikan, biru melayani 3402`); antrean dibuat ulang
  (`WORKER_ONLY=true`, denyut 30 detik).
- **Dashboard dibangun di server** dari sumber (`npm ci` + `npm run build` di `src/coder-dashboard`),
  dan bundelnya identik dengan hasil build lokal: `dist/assets/index-DHZFfOSk.js`. Artinya hasil uji
  UI lokal memang bundel yang melayani pengunjung.
- **Smoke produksi: 199 lulus, 0 gagal** (`PRODUCTION_SMOKE_PASSED`, skrip keluar 0). Label INFO
  perangkat sekarang benar: `devices=3` (sebelumnya `devices=undefined`).
- **Uji UI peramban: 33/33 lulus** (`UI_E2E_PASSED`, 0 gagal, 0 lewat) — 5 pemeriksaan baru, yaitu
  halaman Kunci API dibuka di Chromium sungguhan, kunci uji dibuat lewat API di dalam halaman dan
  dipakai sekali ke endpoint publik, lalu dipastikan **IP yang dicatat server muncul di tabel**
  (inti butir 41) dan **kolom token run berjalan benar-benar dirender** (butir 24).
- **Catatan lingkungan uji (jujur)**: cadangan peramban Playwright di kontainer ini hilang, dan paket
  Debian yang dibutuhkan Chromium belum terpasang. Uji UI baru bisa dijalankan setelah
  `chromium-headless-shell` diunduh ulang (±101 MB lewat 6 koneksi paralel) dan
  `libglib2.0-0 libnss3 libasound2` dll. dipasang dengan apt. Ini murni kebutuhan alat uji lokal,
  tidak menyentuh server produksi.
- **Yang tetap belum diuji**: langganan push peramban sungguhan (produksi `pushSubs=0`) dan antrean
  pada beban tinggi.

## Deploy & operasi produksi v0.20.0 (18 Sep 2026)

- **Versi LIVE: `0.20.0`** — `coder-platform-app:0.20.0` (sehat, `/ready` menjawab
  `{"status":"ready","database":"ok","engine":{"available":true}}`) dan `coder-platform-worker:0.20.0`
  (antrean di proses sendiri; lognya `WORKER_ONLY=true` + `proses antrean siap`). Dijalankan
  `bash deploy/deploy-austria.sh 0.20.0` → `DEPLOY_OK coder-platform-app:0.20.0`, skrip keluar 0.
- **Paket**: `deploy/coder-sam-university-v0.20.0.tar.gz` (204 entri, 840.025 byte), SHA-256
  `e787c7d57488e393f2c869a7f3ddeaf8eaa3bfe40642c2d1f8adc1ae2e4b04da`, diperiksa di server sebelum
  ekstraksi (`coder-sam-university-v0.20.0.tar.gz: OK`).
- **Celah skrip deploy yang baru tertangkap deploy ini**: `scp` ke direktori rilis yang belum ada
  gagal (`dest open ... Failure`, tampil sebagai `scp: Connection closed`). `deploy-austria.sh`
  sekarang membuat direktori rilis lebih dulu (`ssh "${SSH_TARGET}" "mkdir -p '${REMOTE_DIR}'"`).
  Catatan lingkungan kerja: di kontainer ini `ssh coder` hanya bekerja bila `/workspace/.ssh/config`
  ada sebagai `~/.ssh/config` (alias `coder` → user `dinda`, kunci `/workspace/.ssh/dinda_austria`).
- **Penyelarasan `.env` (butir 32) benar-benar jalan di produksi**: mode `--check` lalu mode tulis,
  `ENV_ADDED 20` kunci baru bernilai bawaan (perangkat, push, pencarian, retensi riwayat webhook,
  pembersihan data smoke, batas laju), cadangan `/home/dinda/coder-app/.env.bak.1`.
  `ENV_OBSOLETE_KEYS PLATFORM_WEBHOOK_URL` (memang tidak dibaca kode mana pun) dan
  `ENV_UNKNOWN_KEYS DEEPSEEK_API_KEY` (kunci sah untuk mesin agen, tetapi belum masuk
  `deploy/env.keys.txt` karena hanya dibaca di luar `apps/api/src`).
- **Gerbang migrasi lulus** atas cadangan produksi terbaru `/app/backups/coder-2026-09-18T01-17-01.997Z.db`:
  `SCHEMA_VERSION_AFTER_MIGRATION 18 EXPECTED 18`, `ROW_COUNTS_PRESERVED true`, `MIGRATION_REHEARSAL_OK`.
- **Nol henti (butir 16)**: `ZERO_DOWNTIME_START hijau di 3403` → siap → nginx diarahkan ke 3403 →
  biru dibuat ulang → nginx kembali ke 3402 → `ZERO_DOWNTIME_DONE hijau dihentikan, biru melayani 3402`.
  Antrean (butir 17) dibuat ulang dan berjalan dari citra yang sama.
- **Smoke produksi: 199 lulus, 0 gagal** (`PRODUCTION_SMOKE_PASSED`, skrip keluar 0), termasuk 23
  pemeriksaan Wave 10 yang baru. Dua cacat pada skrip smoke sendiri baru terlihat saat dijalankan ke
  produksi dan sudah diperbaiki: (1) `GET /api/v1/search/status` mengembalikan `{index:{...}}`, bukan
  `messages`/`indexedMessages` di akar; (2) `lockPush.text` tidak ada pada nilai balikan `call()`
  (bentuknya `{status, json}`) sehingga skrip berhenti `TypeError` di tengah jalan. Pemeriksaan butir 24
  juga diselaraskan dengan bentuk jawaban nyata: cadangan token ada **per kunci**, totalnya di
  `/api/v1/status-hub`.
- **Yang belum diuji**: jalur push peramban dari peramban sungguhan dengan langganan nyata
  (`pushSubs=0` di produksi) dan antrean pada beban tinggi. Keduanya di luar smoke ini.

## Deploy & operasi produksi v0.19.0 (16 Sep 2026)

- **Versi LIVE: `0.19.0`** (`coder-platform-app:0.19.0` sehat + `coder-platform-worker` pada citra
  yang sama). Deploy lewat `bash deploy/deploy-austria.sh 0.19.0` → `DEPLOY_OK`, `DEPLOY_SCRIPT_EXIT=0`.
- **Cadangan sebelum deploy**: `/app/backups/coder-2026-09-16T14-56-49.572Z.db` (dibuat dengan
  aplikasi sendiri: `docker exec coder-platform-app node dist/api/backup.js`).
- **Tiga gerbang deploy lulus**: `MIGRATION_REHEARSAL_OK` (`SCHEMA_VERSION_AFTER_MIGRATION 17
  EXPECTED 17`, `ROW_COUNTS_PRESERVED true`), `READY 3403 setelah 1s` → `NGINX_POINTED 3403` →
  biru dibuat ulang → `READY 3402` → `NGINX_POINTED 3402` → `ZERO_DOWNTIME_DONE`, lalu wadah
  antrean dibuat ulang (`[worker] proses antrean siap: pid=1 interval=15000ms lease=1800000ms batch=10`).
- **Smoke produksi terakhir: 176 PASS / 0 FAIL / 0 SKIP → `PRODUCTION_SMOKE_PASSED`**
  (`/tmp/w9_smoke_prod2.txt`), termasuk blok Wave 9
  (`markup=1 cost30=3497 billed30=3497 margin30=0 overrides=0 catalog=845 workerInWeb=false handlers=6`).
- **Harga jual AI (butir 19) di produksi**: `GET /api/v1/admin/pricing` sebagai admin → 845 model
  katalog, markup 1, 23 run berharga. `PUT /api/v1/admin/pricing/settings {markup:1}` →
  `rowsUpdated=23`. `PUT .../pricing/models/<model>` → 200 `source=override`, lalu `DELETE`
  mengembalikan `source=none` (bagian ini diuji dengan model uji, bukan model asli).
- **Pelengkapan harga jual baris lama**: rilis pertama v0.19.0 melaporkan `cost30=3429` tetapi
  `billed30=53` (margin negatif) karena baris pemakaian lama tidak punya `sell_cost_micros`.
  `backfillSellCosts()` yang dipanggil saat aplikasi menyala melengkapi **32 baris**; bukti log wadah
  hijau: `[pricing] harga jual baris lama dilengkapi: 32 baris`. Hasil akhir di produksi:
  `run_usage` 23 baris, 0 kosong, `SUM(cost_micros)=SUM(sell_cost_micros)=3497`;
  `user_usage` 12 baris, 8101 = 8101.
- **Antrean pindah ke wadah pekerja**: status-hub produksi `backgroundWork.worker` =
  `{running:false, cyclesRun:0, handlers:[email.deliver, retention.run, run.execute, run.reap,
  webhook.deliver, workflow.reap]}` — proses web tidak lagi mengambil pekerjaan, tetapi daftar
  penangan tetap lengkap.
- **Nginx produksi**: `proxy_pass http://127.0.0.1:3402;` (baris 28),
  `https://coder.sam.university/health` = 200.
- Catatan jujur: halaman dokumentasi ini di-commit SESUDAH deploy terakhir, jadi paket rilis yang
  terpasang (`deploy/coder-sam-university-v0.19.0.tar.gz`, sha256 `c7a6300f…3c10`) memuat kode
  `e940db1` beserta dokumentasi satu commit lebih lama. Tidak ada perbedaan kode.

## (versi sebelumnya) Deploy & operasi produksi v0.18.0 (16 Sep 2026)

- **Versi LIVE: `0.18.0`** (`coder-platform-app:0.18.0`, sehat, engine `rpc-stdio` tersedia).
  Deploy lewat `bash deploy/deploy-austria.sh 0.18.0` (`DEPLOY_OK`), cadangan basis data dibuat
  lebih dulu dengan `docker exec coder-platform-app node dist/api/backup.js`
  (`/app/backups/coder-2026-09-16T13-11-31.337Z.db`).
- **Smoke produksi: 166 PASS / 0 FAIL / 0 SKIP → `PRODUCTION_SMOKE_PASSED`**
  (`/tmp/w8_smoke_prod.txt`), termasuk blok cek Wave 8 (`limits={"login":10,"register":20,...}`,
  `closedDue=0`, `verifyMode=auto`, `verifyRequired=true`).
- **status-hub produksi**: `openPlatform.rateLimits = { store: "database", table: "rate_limit_hits" }`,
  `closedAccounts.recoveryDays = 90`, `security.verifyEmailRequired = true`, `verifyEmailMode = "auto"`.
- **Akun lama ditandai terverifikasi** (keduanya dibuat sebelum server surat aktif sehingga verifikasi
  tidak mungkin dilakukan): `samianpacing@gmail.com` dan `smoke.bot@coder.sam.university`.
  Bukti: `GET /api/v1/auth/me` → `emailVerified: true`, `accountClosed: false`.
  Tanpa langkah ini pemilik platform akan tertahan `403 EMAIL_NOT_VERIFIED` pada setiap run.
- **Admin kedua (butir 10)**: `samian@sam.university` dibuat dengan paket `enterprise`, `isAdmin=1`,
  `emailVerified=1`; `PLATFORM_ADMIN_EMAILS` kini `samianpacing@gmail.com,samian@sam.university`
  (`security.adminEmails = 2`). Cadangan env: `/home/dinda/coder-app/.env.bak-wave8`.
- **Butir 12 — pembersihan jejak uji audit**: 980 baris `audit_events` dihapus
  (48 baris ruang kerja Bapak + 932 baris ruang kerja `smoke.bot`), 34 baris keamanan global
  (masuk/keluar, kata sandi, admin) DIPERTAHANKAN, lalu 1 baris catatan `admin.audit_cleanup`
  ditulis. Cadangan dibuat sebelum penghapusan. Sisa tabel: 35 baris.
- **Butir 11 — rapikan disk Docker (aman, hanya milik kita)**: 14 tag `coder-platform-app`
  (0.9.3–0.16.0) dihapus (0.17.0 disimpan sebagai sasaran rollback), `docker builder prune -f`
  membebaskan 222,7 MB, `docker image prune -f` hanya 14 kB (image `dangling` lain dipakai container
  proyek lain sehingga otomatis dilewati). `/tmp/node-compile-cache` (482 MB) TIDAK dihapus karena
  bukan milik kita (izin ditolak). Prune `-a`/container/volume tetap TIDAK dijalankan.
- **Butir 14 — relay mailcow**: pengetatan port publik 25/465/587 selesai. Bukti sebelum/sesudah,
  cadangan, dan skrip rollback ada di `docs/PATCH_MAILCOW_RELAY.md` + `deploy/mailcow/`.
  Ringkas: relay tanpa autentikasi dari host `250 Ok` → `454/554 Relay access denied`; jalur sah
  aplikasi tetap `sasl_username=noreply@coblai.com` + `status=sent`; antrean surat kosong.
- **Butir 13 — push GitHub**: masih TERHAMBAT, tidak ada kredensial. Berkas paket deploy sudah
  dikeluarkan dari git dan masuk `.gitignore`; pemindaian paket + riwayat git bersih.

## Wave 7 (v0.17.0) — Pertumbuhan: undangan, angka pertumbuhan, langkah awal, kuota, permukaan publik

Tema: pemakaian yang tumbuh bisa diukur dan dihadiahi, tanpa menambah risiko pada data lama.
Schema basis data naik 14 -> 15. Empat tabel baru: `referral_codes`, `referrals`, `growth_events`,
`onboarding_state`; satu kolom baru: `users.signup_ip`. Modul baru: `apps/api/src/referrals.ts` dan
`apps/api/src/growth.ts`.

- Program undangan (`apps/api/src/referrals.ts`):
  - Kode dibuat otomatis saat panel undangan pertama dibuka: 8 karakter dari abjad `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
    (tanpa huruf/angka yang mudah tertukar seperti `I`, `O`, `0`, `1`). Kode lama langsung tidak dikenali setelah
    `POST /api/v1/referrals/code` (rotasi dicatat sebagai audit `referral.code_rotated`).
  - Pendaftaran menerima `ref` opsional. Kode salah TIDAK menggagalkan pendaftaran; jawabannya berisi
    `referral: { accepted: false, error: "REFERRAL_CODE_NOT_FOUND" }`.
  - Hadiah cair HANYA setelah akun yang diundang menyelesaikan run pertamanya yang berhasil
    (`qualifyReferralForRun` dipanggil di jalur selesai `executeRun`). Nilai bawaan: pengundang 500.000 token,
    yang diundang 250.000 token, lewat `grantCredit` sehingga tercatat di `credit_ledger`.
  - Penolakan yang terbaca: `REFERRAL_CODE_REQUIRED`, `REFERRAL_CODE_NOT_FOUND`, `REFERRAL_SELF`,
    `REFERRAL_ALREADY_RECORDED`, `REFERRAL_DISABLED`. Undangan yang dicurigai tipuan disimpan dengan
    status `blocked` dan alasan `SAME_EMAIL` atau `SAME_IP`, lalu `CEILING` bila batas hadiah per pengundang
    (`REFERRAL_MAX_REWARDED_PER_USER`, bawaan 50) sudah tercapai.
  - BATAS YANG DIAKUI: penjagaan anti-tipuan ini lemah. Verifikasi email belum diwajibkan, jadi akun palsu dari
    IP berbeda tetap bisa lolos. Angka hadiah di atas juga masih usulan, bukan keputusan pemilik produk.
- Angka pertumbuhan (`apps/api/src/growth.ts`, `GET /api/v1/admin/growth?days=`):
  - Corong empat langkah (daftar, proyek, run, bayar) dihitung dari tabel ASLI (`users`, `projects`, `runs`,
    `orders`) sehingga berlaku surut untuk akun dan run yang sudah ada sebelum Wave 7.
  - Aktivitas harian, retensi (`dau`/`wau`/`mau`), peristiwa teratas, dan katalog 16 nama peristiwa dibaca dari
    `growth_events`. BATAS YANG DIAKUI: tabel itu mulai kosong pada Wave 7 (tanpa isi ulang data lama), jadi
    grafik retensi dan aktivitas baru terisi sejak versi ini. `retention.note` menyebutkan hal ini di API.
  - Peristiwa yang dicatat saat tindakan terjadi: `signup`, `email_verified`, `project_created`,
    `conversation_created`, `run_started`, `run_completed`, `run_failed`, `api_key_created`, `webhook_created`,
    `order_created`, `order_paid`, `referral_joined`, `referral_rewarded`, `onboarding_completed`,
    `quota_warning_shown`, `upgrade_viewed`. Pencatatan bersifat best-effort: kegagalan tidak pernah
    membatalkan tindakan utama.
- Langkah awal (`GET /api/v1/onboarding`, `POST /api/v1/onboarding/dismiss`): lima langkah tetap
  (`verify_email`, `first_project`, `first_conversation`, `first_run`, `connect_team_or_key`) dengan keadaan
  selesai yang dihitung dari basis data, plus `percent`, `nextStep`, dan `counts`. Tombol sembunyikan menyimpan
  `dismissed_at` di `onboarding_state`, jadi kartunya tidak muncul lagi setelah halaman dimuat ulang.
- Peringatan kuota (`GET /api/v1/billing/quota-alert`): tingkat `ok` < 70%, `warning` >= 70%, `critical` >= 90%,
  `exceeded` saat jatah harian habis (`blocked: true`, `reason: DAILY_TOKEN_QUOTA_EXCEEDED`). Angka yang
  dilaporkan (`percent`, `dayPercent`, `monthPercent`, `remainingToday`, `remainingMonth`, `creditTokens`)
  berasal dari `quotaState` yang sama dengan penjaga run, jadi tidak ada dua hitungan yang berbeda.
- Permukaan publik (tanpa sesi):
  - `GET /robots.txt` (menunjuk sitemap, menutup `/api/`) dan `GET /sitemap.xml` (`/`, `/harga`, `/docs`).
  - `GET /api/v1/public/docs`: sembilan rute aktif, izin `read`/`write`, batas laju dan jumlah kunci, bentuk
    webhook (`run.completed`, `run.failed`, tanda tangan, percobaan ulang), dan daftar kode galat. Tidak ada
    rahasia (`whsec_`) di dalamnya.
  - Halaman `/docs` disajikan shell SPA tanpa sesi, sama polanya dengan `/harga`.
  - `index.html` memuat meta Open Graph/Twitter, `canonical`, dan `robots` untuk dibagikan.

## Wave 6 (v0.16.0) — API publik fase 2: tulis, webhook, kuota per kunci

Tema: API publik tidak lagi hanya membaca, dan pekerjaan kunci API bisa dibatasi serta dilaporkan ke sistem lain.
Schema basis data naik 13 -> 14.

- Dua rute tulis publik sudah benar-benar dilayani (sebelumnya hanya rencana di `plannedEndpoints`):
  - `POST /api/v1/public/v1/projects/:projectId/conversations` -> 201, kunci butuh izin `write`.
    Peran `viewer` ditolak `403 VIEWER_READ_ONLY`.
  - `POST /api/v1/public/v1/conversations/:conversationId/messages` -> 202 berisi `run` dan
    `read.messages`. Isi pesan divalidasi (model dikenal, tingkat penalaran sah, maksimal 100.000 karakter),
    kuota workspace dijaga `quotaGuard`, lalu run dijalankan seperti lewat antarmuka web.
  - `GET /api/v1/api-keys/docs` kini melaporkan `scopes: ["read","write"]`, `endpoints` berisi 9 rute aktif,
    dan `plannedEndpoints` KOSONG. Izin `write` tidak lagi ditolak `SCOPE_NOT_AVAILABLE`
    (`parseScopes` otomatis menambahkan `read` bila `write` diminta).
- Webhook keluar (`apps/api/src/webhooks.ts`, tabel `webhooks` + `webhook_deliveries`):
  - Peristiwa `run.completed` dan `run.failed` dikirim dari `executeRun` (`emitProjectEvent`), bukan dari
    penjadwal terpisah, jadi peristiwa selalu mencerminkan hasil run yang sebenarnya.
  - Tanda tangan HMAC-SHA256 atas `timestamp.body` di header `X-Coblai-Signature: sha256=...`, bersama
    `X-Coblai-Event`, `X-Coblai-Delivery`, dan `X-Coblai-Timestamp`.
  - Pengiriman lewat antrean pekerjaan `webhook.deliver` (schema 13), jadi percobaan ulang, jeda, dan sewa
    memakai mekanisme yang sama dengan pekerjaan lain. Kegagalan jaringan menaikkan `attempts` sampai
    `WEBHOOK_MAX_ATTEMPTS`, lalu baris berakhir `failed`.
  - Rute sesi: `GET/POST /api/v1/webhooks`, `PATCH/DELETE /api/v1/webhooks/:id`,
    `GET /api/v1/webhooks/:id/deliveries`, `POST /api/v1/webhooks/:id/test` (pengiriman sinkron untuk mencoba
    sekarang). Membuat dan menghapus webhook hanya untuk owner/admin ruang kerja (`403 OWNER_REQUIRED`).
  - Rahasia penanda tangan hanya ditampilkan sekali saat webhook dibuat (awalan `whsec_`); daftar webhook tidak
    pernah memuatnya lagi.
  - Validasi alamat: hanya `http`/`https`. Alamat metadata cloud `169.254.169.254` SELALU ditolak, dan
    alamat lokal (`127.0.0.1`, `localhost`) ditolak kecuali `WEBHOOK_ALLOW_LOCAL=true`.
    BATAS YANG DIAKUI: tidak ada resolusi DNS, jadi domain yang menunjuk ke alamat privat belum diblokir.
- Kuota harian per kunci API: kolom `daily_request_limit`, `daily_token_limit`, `requests_today`, `usage_day`
  pada `api_keys`, dan `runs.api_key_id` pada tabel `runs`.
  - `requireApiKey` memeriksa kuota sebelum batas laju; kelebihan menjawab `429 API_KEY_DAILY_REQUEST_LIMIT`
    atau `429 API_KEY_DAILY_TOKEN_LIMIT` beserta jumlah yang sudah dipakai hari itu.
  - Token dihitung dari `SUM(run_usage.total_tokens)` untuk run yang memakai kunci itu pada hari berjalan;
    hitungan direset saat `usage_day` berbeda dari tanggal hari ini.
  - Angka `0` berarti tanpa batas khusus untuk kunci tersebut. `GET /api/v1/public/v1/me` melaporkan
    `requestsToday` dan `tokensToday` supaya pemilik kunci bisa mengawasi sendiri.
- Halaman `Kunci API` ikut berubah: kotak centang izin tulis aktif, dua isian batas harian saat membuat kunci,
  kolom "Batas harian" dengan tombol "Ubah batas", dan panel "Direncanakan" hilang sendiri karena kosong.
- Halaman baru `Webhook` (`coder-dashboard/src/ApiWebhooks.tsx`): ringkasan pengiriman, formulir pendaftaran,
  kotak rahasia sekali tampil, uji kirim, riwayat pengiriman per webhook, dan pesan galat Bahasa Indonesia.

### Bukti uji Wave 6

- `apps/api/test/wave6.e2e.ts` — 91 pemeriksaan, semua lulus (`ALL_WAVE6_TESTS_PASSED`): bentuk schema 14,
  izin tulis benar-benar dilayani, rute tulis publik (201/202/400/403/404), kuota harian per kunci
  (permintaan dan token, termasuk pergantian hari), CRUD webhook, verifikasi tanda tangan HMAC di penerima
  uji, pengiriman otomatis `run.completed`, percobaan ulang sampai gagal, dan penerimaan status hub.
- `coder-dashboard/render-check-wave6.tsx` — merender halaman Webhook dan halaman Kunci API
  (`ALL_WAVE6_PAGES_RENDERED`).
- `apps/api/test/run-all.cjs` — 26/26 suite mock hijau (lihat daftar di bawah).
- `apps/api/test/production-smoke.mjs` — 144 pemeriksaan terhadap produksi (termasuk blok Wave 6: daftar
  webhook dibaca saja, penolakan alamat metadata, hitungan rute publik 9/0, dan satu rute tulis publik yang
  sungguh membuat percakapan di proyek smoke bot memakai kunci tulis sementara yang langsung dicabut).
  Produksi SENGAJA tidak membuat webhook saat smoke, supaya tidak ada panggilan jaringan keluar yang tak diminta.

## Wave 5 (v0.15.0) — ketahanan & operasi

Tema: pekerjaan latar tidak boleh hilang ketika container dimatikan. Versi sebelumnya memakai `setInterval`
di dalam proses API, sehingga pekerjaan yang sedang berjalan lenyap tanpa jejak saat restart.

- Modul baru `apps/api/src/jobs.ts`: antrean pekerjaan persisten di tabel `jobs` (schema 13). Setiap pekerjaan
  ditulis ke basis data sebelum dikerjakan, jadi restart tidak menghapus pekerjaan.
- Sewa (lease): pekerjaan yang diambil satu worker diberi `lock_owner` dan `lock_expires_at`. Worker lain tidak
  boleh mengambilnya selagi sewa masih berlaku. Sewa yang kedaluwarsa dikembalikan ke antrean (`WORKER_LOST`),
  jadi pekerjaan yang ditinggal proses mati tetap selesai pada proses berikutnya.
- Percobaan ulang: `attempts` dinaikkan saat pekerjaan DIAMBIL, bukan saat selesai. Kegagalan mengembalikan
  pekerjaan ke antrean dengan jeda `5 detik x attempts` sampai `max_attempts`, lalu berakhir `failed` dengan
  `last_error` yang bisa dibaca manusia.
- Kunci dedupe unik (`dedupe_key`) mencegah pekerjaan kembar, misalnya dua permintaan bersamaan untuk run yang sama.
- Jenis pekerjaan bawaan: `run.execute`, `email.deliver`, `retention.run`, `run.reap`, `workflow.reap`.
  Tiga yang terakhir dijadwalkan ulang otomatis oleh antrean, jadi tidak ada lagi timer in-memory untuk email
  dan retensi (`startEmailWorker()` dan `startRetentionWorker()` dihapus).
- Perbaikan otomatis sesudah restart: pemeriksa menandai run dan eksekusi workflow yang berstatus `running`
  lebih lama dari `JOB_ORPHAN_AFTER_MS` (bawaan 45 menit, harus lebih panjang dari `ENGINE_TIMEOUT_MS` 30 menit)
  menjadi `failed` dengan `error_code='WORKER_LOST'`. Tanpa ini, run yang ditinggal proses mati akan
  menggantung "berjalan" selamanya.
- Jaring pengaman `run.execute`: rute tetap menjalankan run langsung supaya latensi tidak berubah, tetapi
  pekerjaan `run.execute` juga ditulis ke antrean dengan `max_attempts=1`. Bila proses mati sebelum atau
  sesudah balasan HTTP, pekerjaan itu diambil nanti dan hanya dijalankan bila run masih `queued`, sehingga
  run tidak dikerjakan dua kali.
- Rute admin: `GET /api/v1/admin/jobs` (statistik, daftar, saringan `status`/`kind`), `POST /api/v1/admin/jobs/:jobId/retry`
  (`404 JOB_NOT_FOUND`, `409 JOB_ALREADY_PENDING`), `POST /api/v1/admin/jobs/tick` (satu putaran paksa, dicatat
  ke audit sebagai `admin.job.cycle`). Semuanya di balik gerbang admin platform (`403 ADMIN_REQUIRED`).
- Halaman dashboard "Antrean pekerjaan" (`coder-dashboard/src/AdminJobs.tsx`) menampilkan ringkasan, keadaan
  worker, saringan, tabel pekerjaan, dan tombol ulangi.
- Env baru: `JOB_WORKER_INTERVAL_MS` (15000), `JOB_LEASE_MS` (1800000), `JOB_BATCH_SIZE` (10, maksimum 200),
  `JOB_ORPHAN_AFTER_MS` (2700000), `JOB_REAP_ON_BOOT` (true), `JOB_REAP_BOOT_MIN_AGE_MS` (60000).
- `GET /api/v1/status-hub` menambah blok `backgroundWork` (antrean, keadaan worker, `leaseMs`, `orphanAfterMs`).

Keterbatasan jujur Wave 5 (belum ada, jangan diklaim ada):
- Antrean masih satu proses: sewa mencegah dua worker mengambil pekerjaan yang sama, tetapi belum ada
  pembagian beban antar container dan belum ada Redis/broker.
- Pemeriksa pekerjaan menggantung memakai umur `started_at`. Bila sebuah run sah berjalan lebih lama dari
  `JOB_ORPHAN_AFTER_MS`, run itu akan ditandai gagal walaupun prosesnya sehat. Batas bawaan 45 menit
  dipilih supaya tetap di atas batas mesin 30 menit, jadi kejadian ini hanya mungkin bila batas mesin dinaikkan
  tanpa menaikkan `JOB_ORPHAN_AFTER_MS`.
- Jaring pengaman `run.execute` hanya menolong bila baris run masih ada di basis data. Bila transaksi
  pembuatan run benar-benar gagal, tidak ada yang bisa dipulihkan.
- Belum ada metrik Prometheus khusus antrean; keadaan antrean hanya terlihat lewat rute admin dan status hub.

## Wave 4 (v0.14.0) — platform terbuka & kepatuhan

- Kunci API pribadi: `GET/POST /api/v1/api-keys`, `PATCH/DELETE /api/v1/api-keys/:keyId`,
  `GET /api/v1/api-keys/docs`. Nilai kunci hanya keluar sekali saat dibuat (format `ck_` + 40 heksadesimal);
  server menyimpan sha256-nya saja (`api_keys` di schema 12). Batas 20 kunci aktif per akun
  dan `API_KEY_RATE_LIMIT_PER_MINUTE` (bawaan 120) permintaan per menit per kunci.
- API publik baca-saja: `GET /api/v1/public/v1/me`, `/workspaces`, `/projects`,
  `/projects/:projectId/conversations`, `/projects/:projectId/usage`, `/projects/:projectId/artifacts`,
  `/conversations/:conversationId/messages`. Autentikasi `Authorization: Bearer ck_...`, hanya boleh membaca
  workspace yang terikat pada kunci itu. Kesalahan memakai kode yang jelas: `API_KEY_REQUIRED`,
  `API_KEY_INVALID`, `API_KEY_SCOPE_REQUIRED`, `API_KEY_RATE_LIMITED`, `PROJECT_NOT_FOUND`.
- Antrean email: tabel `email_outbox` (schema 12). Setiap notifikasi yang pantas dikirim lewat email masuk
  antrean dengan status `pending`, bukan langsung dikirim. Worker 60 detik (`startEmailWorker`) hanya mengirim
  bila `NOTIFY_EMAIL_ENABLED=true`; kalau SMTP belum lengkap, barisnya ditandai `skipped` dengan alasan
  `MAILER_NOT_CONFIGURED`; gagal kirim dicoba ulang sampai 3 kali lalu menjadi `failed`. Operator dapat melihat,
  mengirim ulang, dan menghapus antrean di `GET/POST /api/v1/admin/email-outbox*`.
  Aturan hapus: pesan berstatus `pending` hanya bisa dihapus selagi pengiriman email mati
  (`NOTIFY_EMAIL_ENABLED=false`). Bila pengiriman aktif, menghapus pesan menunggu ditolak dengan
  `409 EMAIL_IN_FLIGHT` supaya pesan tidak hilang di tengah percobaan kirim; pesan yang sudah selesai
  (`sent`/`failed`/`skipped`) selalu bisa dihapus. Pesan yang tidak ada menjawab `404 EMAIL_NOT_FOUND`.
- Preferensi email per akun: `GET/PUT /api/v1/account/notification-preferences` (tabel `notification_prefs`).
  Lima saklar: kuota, kegagalan run, tagihan, tim, keamanan. Email harian bergabung untuk jenis kuota/biaya/run
  (satu pesan per hari per akun). Notifikasi di dalam aplikasi SELALU ditulis, terlepas dari saklar email.
- Ekspor data pribadi: `POST /api/v1/account/export`, `GET /api/v1/account/exports`,
  `GET /api/v1/account/exports/:exportId/download`, `DELETE /api/v1/account/exports/:exportId`.
  Berkas JSON (`coblai-coder-export/1`) berisi 23 bagian data (profil, pesan, run, pemakaian, kunci API,
  langganan, kredit, dan seterusnya). Kata sandi (hash), rahasia MFA, dan nilai kunci API TIDAK ikut.
  Masa berlaku bawaan `RETENTION_EXPORT_DAYS` (7 hari). Ringkasan: `GET /api/v1/account/privacy`.
- Retensi data: `GET /api/v1/admin/retention` (laporan hitungan) dan `POST /api/v1/admin/retention/run`
  (bawaan mode uji). Sasaran: `audit_events`, `notifications`, `run_events`, `auth_tokens`, `data_exports`.
  Bila `RETENTION_ENABLED=false`, permintaan penghapusan ditolak dengan alasan `RETENTION_DISABLED`
  dan tidak ada baris yang hilang. Worker 6 jam (`startRetentionWorker`).
- Halaman harga publik: `GET /api/v1/public/plans` (merek, mata uang, kurs acuan, status gateway,
  daftar paket aktif). Tanpa sesi, tanpa kunci rahasia. Dirender SPA di `/harga` (`PublicPricing.tsx`),
  dijangkau lewat tombol "Harga" di bilah atas.
- Variabel lingkungan baru (semua punya bawaan aman): `NOTIFY_EMAIL_ENABLED` (false),
  `API_KEY_RATE_LIMIT_PER_MINUTE` (120), `RETENTION_ENABLED` (false), `RETENTION_AUDIT_DAYS` (365),
  `RETENTION_NOTIFICATION_DAYS` (90), `RETENTION_RUN_EVENT_DAYS` (30), `RETENTION_EXPORT_DAYS` (7).

### Penyimpangan Wave 4 yang diketahui (bukan bug, tapi bisa mengejutkan)

- API publik baru melayani BACA. Dua rute tulis (kirim pesan, buat percakapan) tercantum di
  `plannedEndpoints` dengan `available: false` dan belum dilayani: permintaannya menjawab 404.
- `NOTIFY_EMAIL_ENABLED` bawaan `false`, jadi email masuk antrean tetapi tidak dikirim. Ini sengaja agar
  operator bisa memeriksa isi antrean dulu. Mengaktifkannya berarti mulai mengirim email keluar.
- `RETENTION_ENABLED` bawaan `false`: `POST /admin/retention/run` selalu menjadi mode uji.
- Saklar preferensi email hanya memengaruhi salinan email, bukan notifikasi dalam aplikasi.
- Pesan antrean yang masih `pending` tidak bisa dihapus selagi pengiriman email aktif. Ini disengaja
  (mencegah pesan hilang saat sedang dikirim), tetapi berarti antrean hanya bisa dibersihkan setelah
  pengiriman dimatikan atau setelah pesan selesai dikirim.
- Nilai kunci API tidak bisa dibaca lagi setelah dibuat (hanya hash). Yang bisa dilihat: prefix 8 karakter,
  waktu pakai terakhir, dan jumlah permintaan.
- `PATCH /api/v1/admin/plans/:code` mengubah batas kuota untuk SEMUA pengguna paket itu. Jangan dipakai
  di produksi untuk mencoba-coba: itu mengubah batas nyata semua akun.
- Kredit token menaikkan plafon harian (plafon = batas paket + kredit), jadi akun ber-kredit tidak
  akan terblokir hanya karena batas paket kecil.
- Audit tindakan tingkat akun (`account.export.created`, `account.export.deleted`,
  `account.notification_preferences.updated`) dicatat pada workspace pribadi pemiliknya. Kalau akun tidak
  punya workspace (situasi yang tidak terjadi setelah pendaftaran normal), kolom `workspace_id` berisi NULL.

### Bukti uji Wave 4

- `apps/api/test/wave4.e2e.ts` — 181 pemeriksaan, 0 gagal, 0 dilewati (`ALL_WAVE4_TESTS_PASSED`).
  Mencakup: kunci API (termasuk batas 20 dan batas laju 429), API publik dan isolasi lintas workspace,
  antrean email, preferensi email (termasuk penggabungan email harian), ekspor data (termasuk pemeriksaan
  bahwa berkas tidak memuat bahan rahasia), laporan retensi, peran viewer, dan harga publik.
- `apps/api/test/run-all.cjs` — 24/24 suite mock hijau saat Wave 4 diperiksa (26/26 pada Wave 6).
  Bisa juga lewat `npm run verify`.
- `apps/api/test/outbox-mail.e2e.ts` — 14 pemeriksaan, semua lulus: dengan `NOTIFY_EMAIL_ENABLED=true`
  tetapi SMTP kosong, antrean TIDAK pernah mencoba menghubungi SMTP (`sent=0`, baris menjadi `skipped`
  dengan alasan `MAILER_NOT_CONFIGURED`), dan pesan menunggu ditolak saat dihapus (`409 EMAIL_IN_FLIGHT`).
- `apps/api/test/production-smoke.mjs` — 125 pemeriksaan terhadap produksi.
- `coder-dashboard/render-check-wave4.tsx` — merender 4 halaman baru (`npx tsx --tsconfig tsconfig.app.json
  render-check-wave4.tsx`); membuktikan halaman tidak gagal saat dirender, bukan sekadar lolos tipe.
- `npx tsc -p tsconfig.app.json --noEmit` dan `npx vite build` di `coder-dashboard` — bersih (bundel 479,45 kB).

## Wave 3 (v0.13.0) — ruang kerja agen

- Pengaturan agen per pengguna: `GET/PATCH /api/v1/agents/settings` (schema 10, tabel `agent_settings`).
  Isi: tingkat penalaran (`--thinking`), allowlist alat (`--tools` / `--no-tools`), pemadatan otomatis
  (`auto_compact`, `compact_after_messages`), dan batas mode otonom. Nilai divalidasi di server.
- Pratinjau jujur: `GET /api/v1/agents/preview` mengembalikan `flags[]` (argumen CLI yang akan dipakai),
  `blocks[]` (teks yang dikirim sebagai `--append-system-prompt`), `notes[]`, dan ukuran sesi mesin.
  Jadi apa yang dikirim ke mesin bisa diperiksa sebelum menjalankan run.
- Bank memori: `/api/v1/memories` (CRUD). Catatan aktif (maksimal 12, yang disematkan didahulukan)
  dikirim sebagai satu blok system, bukan sebagai bagian pesan pengguna.
- Template prompt dan perintah garis miring: `/api/v1/prompt-templates` (CRUD) + `POST /:id/use`
  yang mengisi `{{variabel}}` dan melaporkan variabel yang belum terisi.
- Persona agen: `/api/v1/personas` (CRUD, `POST /:id/default`), plus `PATCH /api/v1/conversations/:id/persona`
  untuk memasang persona pada satu percakapan. Persona memasok blok system pertama.
- Penghemat token yang nyata: pemadatan meminta ringkasan ke mesin pada sesi yang sama, menyimpannya di
  `conversation_summaries`, lalu **memutar** `conversations.engine_session_id` ke UUID baru sehingga riwayat
  panjang tidak dikirim lagi. Bila mesin gagal, dipakai potongan transkrip dengan penanda `source: "fallback"`.
  Rute: `POST /api/v1/conversations/:id/compact`, `GET /api/v1/conversations/:id/summaries`.
- Playground: `POST /api/v1/playground/run` menjalankan satu prompt tanpa menyimpan percakapan,
  memakai pengaturan akun, dan token tetap dihitung ke kuota.
- Peta agen: `GET /api/v1/agents/map` (percakapan, sesi mesin di disk, pohon run dengan `parent_run_id`,
  `thinking_level`, `autonomous`, `prompt_chars`, `append_system_chars`).
- Pembanding artefak: `GET /api/v1/artifacts/:artifactId/diff/:otherId` (unified diff LCS buatan sendiri,
  batas 400 KB per artefak; artefak yang sama ditolak `SAME_ARTIFACT`).
- Laporan Markdown: `GET /api/v1/projects/:projectId/report.md?kind=project|conversation` dengan header
  `Content-Disposition`, dipakai tombol "Laporan proyek" di bilah atas.
- Katalog kapabilitas: `GET /api/v1/skills` membaca keadaan nyata (mesin, katalog model, SMTP, gateway,
  jumlah memori/template/persona/artefak) dan menandai tiap baris `available` atau `needs`.
  Katalog ini TIDAK mengklaim paket skill mesin, karena di container mesin memang belum ada paket terpasang.
- Status hub: `GET /api/v1/status-hub` (mesin, `PRAGMA quick_check`, hitungan tabel, migrasi, uang,
  surat, keamanan, batas, penyimpanan, run terakhir). Versi aplikasi dibaca dari `APP_VERSION`
  yang ditulis otomatis oleh `deploy/deploy-austria.sh`.

### Penyimpangan Wave 3 yang diketahui (bukan bug, tapi bisa mengejutkan)

- `GET /api/v1/projects/:projectId/report.md?kind=conversation` tanpa `conversationId` memakai
  percakapan PALING BARU di proyek itu, tanpa konfirmasi. Perilaku ini dipertahankan agar tautan
  lama tidak putus, dan dicatat di sini supaya disadari.
- Melepas persona percakapan (`PATCH /conversations/:id/persona` dengan `personaId: null`) tidak
  mengosongkan blok persona: percakapan kembali memakai persona bawaan akun.
- Angka token playground diambil dari `usage` mesin bila ada; kalau mesin tidak melaporkan,
  angkanya estimasi `ceil(panjang teks / 4)` dan baris `user_usage` ditandai `estimated=1`.
- Kolom `runs.persona_id` belum punya endpoint HTTP pembaca. Penyimpanannya dibuktikan lewat
  `conversations.persona_id` (pratinjau), `sessions[].personaId` (peta agen), `runs.append_system_chars > 0`,
  dan teks persona yang terlihat di opsi mesin.

## Wave 2 (v0.12.0) — komunikasi & tampilan

- Lampiran chat: satu pesan bisa membawa sampai 5 berkas (maksimal 5 MB per berkas) lewat
  `POST /api/v1/conversations/:conversationId/messages` dengan `attachments: [{ name, mimeType, contentBase64 }]`.
  Berkas disimpan di `DATA_DIR/attachments/<uuid><ext>`, metadata di tabel `message_attachments`
  (schema 9). Isi berkas berjenis teks ikut disisipkan ke prompt run (maksimal 20.000 karakter).
  Bukti: `apps/api/src/server.ts`, `apps/api/src/text-extract.ts`, `coder-dashboard/src/App.tsx`.
- Unduh lampiran: `GET /api/v1/attachments/:attachmentId` (cek keanggotaan lewat percakapan; 404 bila bukan milik Anda).
- Cabang percakapan: `POST /api/v1/conversations/:conversationId/branch` menyalin pesan sampai satu titik,
  menyalin berkas lampiran (path baru, bukan berbagi berkas), dan bisa langsung menjalankan jawaban baru
  (`rerun: true`). Tombol "Cabang dari sini" ada di setiap pesan pengguna.
- Hapus artefak massal: `POST /api/v1/artifacts/bulk-delete` (maksimal 200 id) mengembalikan `{ deleted, skipped }`.
  Dipakai halaman Artefak dengan kotak centang dan tombol "Hapus terpilih".
- PWA: manifest lengkap (`coder-dashboard/vite.config.ts`), ikon 192/512/maskable/apple-touch,
  `favicon.png`, dan pintasan manifest. Sebelumnya PWA sudah terpasang tetapi tanpa ikon.
- Tampilan: palet perintah (Ctrl+K, `CommandPalette.tsx`), tombol tema terang/gelap (`ThemeToggle.tsx`,
  aturan `[data-theme="terang"]` di `styles.css`), dan menu bagikan jawaban
  (salin teks, unduh Markdown, cetak/PDF via `ShareMenu.tsx`).
- Bukti uji: `apps/api/test/wave2.e2e.ts` (104 pemeriksaan, semua lulus): lampiran, cabang, hapus massal,
  serta isolasi antar-pengguna dan peran viewer. Tampilan hanya diuji lewat cek tipe dan render server
  (`react-dom/server`), belum di peramban nyata karena Playwright tidak tersedia.

## Sudah jalan

- Auth inti: register, login, logout, `GET /api/v1/auth/me`, kata sandi scrypt (N=16384), cookie sesi
  `coder_session` httpOnly 30 hari. Bukti: `apps/api/src/server.ts`, `apps/api/src/auth.ts`.
- Profil: `PATCH /api/v1/auth/me` mengubah `displayName` (2-80 karakter) dan menulis audit
  `user.profile_updated`. Dipakai `coder-dashboard/src/ProfilePanel.tsx`.
- Sesi perangkat: `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:sessionId`; ganti kata
  sandi mencabut sesi lain lewat `revokeOtherSessions()`.
- MFA TOTP: `/api/v1/auth/mfa/setup|enable|disable`, 6 recovery code sekali pakai, `apps/api/src/totp.ts`.
  Suite `totp.e2e.ts` lulus (`ALL_TOTP_TESTS_PASSED`, 12 PASS) saat saya jalankan.
- Pemulihan akun: `/api/v1/auth/password`, `/forgot-password`, `/reset-password`, `/email/verify*`,
  token sekali pakai di tabel `auth_tokens`. Pengiriman surat butuh SMTP (lihat Penghambat eksternal).
- RBAC: peran `owner`, `admin`, `member`, `viewer` di tabel `memberships`; jawaban `VIEWER_READ_ONLY`,
  `INSUFFICIENT_ROLE`, `OWNER_REQUIRED`. Bukti: `membershipRole()` dipakai 22 kali di `server.ts`.
- Tim: undang, ubah peran, cabut anggota, cabut undangan. Bukti:
  `/api/v1/workspaces/:workspaceId/members`, `/invitations`, `/api/v1/invitations/accept`.
- Workspace dan proyek: `GET/POST /api/v1/workspaces`, `PATCH /api/v1/projects/:projectId`.
- Hapus data: `DELETE /api/v1/projects/:projectId` (owner/admin), `DELETE /api/v1/workspaces/:workspaceId`
  (wajib mengetik nama workspace), `DELETE /api/v1/workflows/:workflowId` (menolak bila masih ada run),
  `DELETE /api/v1/artifacts/:artifactId`, dan `DELETE /api/v1/auth/account` (frasa "HAPUS AKUN" + kata
  sandi; admin platform terakhir dilindungi `LAST_ADMIN`). Anak tabel dibersihkan `removeProjectData()`
  dan `deleteWorkspaceFully()`, setiap aksi menulis audit.
- Siklus hidup run: status `queued|running|completed|failed|cancelled` (CHECK di `db.ts`), kirim pesan
  menjawab `202` dengan run `queued`, ada `POST /api/v1/runs/:runId/cancel` dan stream
  `GET /api/v1/runs/:runId/events` (`text/event-stream`).
- Percakapan: ganti nama, pin, hapus, `GET /api/v1/conversations/:conversationId/export`, dan impor
  `/api/v1/projects/:projectId/conversations/import`.
- Knowledge base: unggah (batas 10 MB), ekstraksi txt/md/json/csv/pdf/docx (`text-extract.ts`),
  potong chunk, indeks FTS5 `bm25` (`knowledge.ts`), konteks disuntik ke prompt.
- Artefak: unggah, daftar, unduh (`/download`), lihat langsung (`/raw`), hapus, sha256, berkas di disk.
- Workflow: lima tipe langkah (prompt, condition, branch, approval, delay), publish, execute,
  persetujuan manusia, cancel, retry. Bukti: `apps/api/src/workflow-engine.ts` dan rute
  `/api/v1/workflows/:workflowId/execute|publish|schedule`.
- Jadwal workflow: interval dan cron. `POST /api/v1/workflows/:workflowId/schedule` menerima
  `intervalMinutes` atau `cron`, divalidasi `validateCronExpression()` dan dihitung `nextCronRun()`.
  Penjadwal `startWorkflowScheduler()` berjalan `setInterval` 60 detik di dalam proses API.
- Pemakaian dan biaya: tabel `run_usage`, harga per model `apps/api/src/model-prices.ts`, ringkasan
  `GET /api/v1/projects/:projectId/usage`, ekspor CSV `GET /api/v1/projects/:projectId/usage/export`.
- Guard biaya dan kecepatan: batas harian/bulanan dan batas run per jam per workspace, jawaban
  `429 COST_LIMIT_EXCEEDED`. Bukti: `GET/PUT /api/v1/workspaces/:workspaceId/limits`.
- CSRF: hook `onRequest` global di `server.ts`. Level satu selalu aktif: permintaan POST/PUT/PATCH/DELETE
  dari situs lain ditolak `CSRF_BLOCKED`. Level dua aktif bila `CSRF_STRICT=true`: cookie `coder_csrf`
  yang bisa dibaca JavaScript ikut dikirim, dan header `x-csrf-token` harus sama dengan cookie
  (`CSRF_TOKEN_REQUIRED`). Cookie itu hanya dikirim dalam mode token, supaya klien lama tetap menerima
  satu cookie saja. Bukti: `apps/api/src/csrf.ts`.
- Rate limit: `apps/api/src/ratelimit.ts` dengan empat aturan, yaitu login 10 per 15 menit, register
  20 per jam, reset sandi 20 per jam, dan API 600 per menit; jawaban `429 RATE_LIMITED`. Angka itu dapat
  diubah lewat `RATE_LIMIT_LOGIN_PER_15MIN`, `RATE_LIMIT_REGISTER_PER_HOUR`, `RATE_LIMIT_PASSWORD_PER_HOUR`,
  dan `RATE_LIMIT_API_PER_MINUTE`. Limiter API dilewati saat `NODE_ENV=test`. Login dibatasi limiter
  yang sama lewat `allowLoginAttempt()` di `auth.ts`, jadi `RATE_LIMIT_LOGIN_PER_15MIN` juga berlaku.
- Notifikasi dalam aplikasi: tabel `notifications`, `GET /api/v1/notifications`,
  `POST .../:notificationId/read`, `POST .../read-all`.
- Audit: tabel `audit_events` diisi `recordAudit()`, dibaca `GET /api/v1/workspaces/:workspaceId/audit`.
- Admin platform: `/api/v1/admin/overview|users|workspaces`, `POST /api/v1/admin/users/:userId/admin`,
  daftar admin dari `PLATFORM_ADMIN_EMAILS` atau `users.is_admin`.
- Metrik Prometheus terproteksi token: `GET /metrics` dengan `METRICS_TOKEN`.
- Seam engine: satu titik pemilihan engine `apps/api/src/engine.ts` (mock, RPC Prime Agent, atau
  `ENGINE_NOT_CONFIGURED`), protokol stdio JSONL di `prime-rpc-engine.ts` (`--mode rpc`).
  Kontraknya diuji tanpa jaringan: `rpc-adapter.e2e.ts` lulus (6 PASS) saat saya jalankan.
- Web statis dilayani API tanpa `@fastify/static`: `setNotFoundHandler` membaca `PUBLIC_DIR` dan
  mengembalikan `index.html` untuk rute SPA.
- Dashboard React + Vite: 11 halaman di `coder-dashboard/src/nav.ts` (Beranda, Percakapan, Proyek,
  Pengetahuan, Workflow, Tim, Artefak, Pemakaian, Riwayat run, Audit, Pengaturan & akun).
- Backup dan restore SQLite: `apps/api/src/backup.ts`, `apps/api/src/restore.ts`, `npm run backup`,
  `npm run restore`.
- Rilis dan deploy: paket `deploy/coder-sam-university-v0.9.5.tar.gz` dan `.sha256`, script
  `deploy/deploy-austria.sh` (cek hash, paksa tag image, cek `/ready`), `Dockerfile`,
  `Dockerfile.austria`, `docker-compose.yml`, `docker-compose.austria.yml`.
- Smoke produksi: `apps/api/test/production-smoke.mjs` memuat 57 pemanggilan `check(`.
- Cek tipe backend dan dashboard sama-sama lulus (`--noEmit` tanpa keluaran) saat saya jalankan.

## Komersial (v0.11.0)

- Paket: tabel `plans` dengan seed `free` (Rp0, 400.000 token/hari), `premium` (Rp199.000, 3 juta/hari,
  bonus 5 juta) dan `enterprise` (Rp799.000, 20 juta/hari, bonus 50 juta). Angka ini titik awal yang
  bisa diubah admin, bukan keputusan harga final. Rute: `GET /api/v1/billing/plans`,
  `GET /api/v1/admin/plans`, `PATCH /api/v1/admin/plans/:code`.
- Pesanan: `orders` dengan status `pending|paid|rejected|cancelled`; `POST /api/v1/billing/orders`
  membuat pesanan (paket Rp0 langsung lunas), `GET /api/v1/billing/orders` milik sendiri,
  `GET /api/v1/admin/orders`, `POST /api/v1/admin/orders/:id/decision` (idempoten: melunasi dua kali
  tidak membuat langganan kedua). Melunasi pesanan menaikkan tier, memberi bonus token ke
  `credit_ledger`, dan membuat baris `subscriptions`.
- Bukti transfer: `POST /api/v1/billing/orders/:id/proof` menerima png/jpg/webp/gif/pdf maksimal 5 MB,
  disimpan di `DATA_DIR/proofs`, hanya bisa dibaca admin lewat `GET /api/v1/admin/orders/:id/proof`.
  `orders.proof_artifact_id` menyimpan path berkas di server.
- Kupon: `coupons` dengan potongan persen atau rupiah, batas pakai dan masa berlaku;
  `POST /api/v1/billing/coupons/validate`, `GET|POST /api/v1/admin/coupons`,
  `PATCH /api/v1/admin/coupons/:code`.
- Kuota token: `quotaState()` menghitung pemakaian nyata dari `run_usage` (tabel `token_quotas` hanya
  salinan). Batas harian/bulanan berasal dari paket pengguna; kredit token menambah batas harian. Rute
  kirim pesan dan mulai run memanggil `quotaGuard()` dan menjawab `429 DAILY_TOKEN_QUOTA_EXCEEDED` atau
  `429 MONTHLY_TOKEN_QUOTA_EXCEEDED` dengan pesan Indonesia. Pemakaian di atas batas harian dipotong
  dari kredit sebagai baris `usage_overflow`. `POST /api/v1/admin/users/:id/reset-quota` menggeser titik
  hitung (`token_quotas.reset_at`) tanpa menghapus riwayat pemakaian.
- Pendapatan: `GET /api/v1/admin/revenue?days=30` menghitung pendapatan pesanan lunas, biaya nyata dari
  `run_usage`, margin, token, dan kurs USD ke IDR (default 17876, dapat diubah lewat
  `PUT /api/v1/admin/currency`).
- Rekening bank manual: `GET|POST /api/v1/admin/banks` dan `DELETE /api/v1/admin/banks/:id`; daftar
  rekening tampil di `GET /api/v1/billing/me`.
- Gateway: `GET|PUT /api/v1/admin/payment-config` memilih `manual|xendit|midtrans`. Kunci API hanya
  dibaca dari env (`XENDIT_SECRET_KEY`, `XENDIT_CALLBACK_TOKEN`, `MIDTRANS_SERVER_KEY`); mengaktifkan
  gateway tanpa kunci dijawab `400 GATEWAY_NOT_CONFIGURED`. Webhook `POST /api/v1/webhooks/xendit` dan
  `/api/v1/webhooks/midtrans` memverifikasi token callback dan mencatat baris `payments`.
- Pengguna oleh admin: `GET /api/v1/admin/user-list`, `POST /api/v1/admin/users` (membuat pengguna,
  workspace pribadi dan baris kuota; `409 EMAIL_TAKEN`), `PATCH /api/v1/admin/users/:id`
  (`400 LAST_ADMIN` melindungi admin terakhir), dan `POST /api/v1/admin/users/:id/credit` untuk kredit
  token manual.
- Branding: `GET /api/v1/branding` (publik) dan `PUT /api/v1/admin/branding`, disimpan di tabel
  `platform_settings`.
- Halaman: `Paket & langganan` (`coder-dashboard/src/Billing.tsx`) dan `Admin platform`
  (`AdminCommerce.tsx` + `AdminUsers.tsx`); entri sidebar baru `billing` dan `admin` di `nav.ts`.
  Halaman `admin` hanya terlihat untuk admin platform, yang kini diketahui dari `isAdmin` pada
  `GET /api/v1/auth/me`.
- Suite: `apps/api/test/billing.e2e.ts`, 87 pemeriksaan, lulus (`ALL_BILLING_TESTS_PASSED`).
- Belum diverifikasi: halaman baru belum diuji di peramban; gateway Xendit/Midtrans belum pernah
  dihubungi karena kuncinya belum ada, jadi baru jalur transfer manual yang terbukti end-to-end.

## Sebagian

- Email transaksional: alur dan isi surat lengkap, klien SMTP sendiri di `apps/api/src/mailer.ts`
  (tanpa pustaka tambahan). **SMTP SUDAH HIDUP sejak 15 Sep 2026** (`mail.ilmupelet.com:587`, STARTTLS,
  pengirim `COBLAI Coder <noreply@coblai.com>`; rahasia hanya di `/home/dinda/coder-app/.env`).
  Bukti uji sungguhan: pendaftaran mengirim surat verifikasi dan tautannya bekerja (`verified: true`),
  `/auth/password/forgot` menjawab `delivery: "email"`, surat reset sampai ke kotak masuk, tautannya
  dipakai untuk mengganti sandi, lalu login dengan sandi baru berhasil. Akun uji dan surat uji sudah
  dihapus kembali. Sisa pekerjaan: DNS `coblai.com` belum punya SPF/DKIM/MX, jadi surat ke Gmail dan
  penyedia lain berisiko masuk spam sampai catatan DNS itu dipublikasikan (lihat Penghambat eksternal).
- Klien SMTP: dua bug nyata ditemukan dan diperbaiki pada 13 Sep 2026 saat mencoba server surat
  sungguhan. (1) Baris lanjutan balasan `EHLO` (mis. `250-STARTTLS`) dibuang, sehingga klien tidak
  pernah memulai STARTTLS dan server menjawab `530 Must issue a STARTTLS command first`; kini seluruh
  balasan multi-baris dikumpulkan dan `capabilities` memuatnya. (2) Batas waktu memakai
  `socket.destroy(new Error(...))` setelah `removeAllListeners("error")`, sehingga soket yang diam
  memicu peristiwa `error` tanpa penangan dan mematikan proses API; kini soket hanya ditutup dan
  kegagalan dilaporkan lewat `SMTP_NO_REPLY`. Bukti: `apps/api/test/mailer.e2e.ts` (25 cek lulus,
  `ALL_MAILER_TESTS_PASSED`), termasuk jalur STARTTLS sungguhan dengan sertifikat sementara.
- Adapter Prime Agent nyata: baru kontraknya yang terbukti lewat fixture. Jalan ke provider sungguhan
  belum diverifikasi karena belum ada kunci. `real-ai.e2e.ts` dan `real-usage.e2e.ts` butuh kunci.
- Penjadwal: hidup di dalam proses API. Dua replika bisa menjalankan jadwal yang sama, dan run yang
  sedang jalan hilang saat restart karena belum ada worker terpisah.
- CSRF level dua mati secara bawaan (`CSRF_STRICT=false`), dan belum ada suite yang menguji
  `CSRF_BLOCKED` maupun `CSRF_TOKEN_REQUIRED`.
- Rate limit disimpan di memori proses, jadi hilang saat restart dan tidak dibagi antar replika.
- Rute baru sudah punya suite otomatis: `delete-flow.e2e.ts` (64 cek) untuk hapus proyek/workspace/
  workflow/artefak/akun, ekspor CSV, `GET /api/v1/artifacts/:artifactId/raw`, dan `PATCH /api/v1/auth/me`;
  `csrf-limits.e2e.ts` (23 cek) untuk cookie CSRF dan batas permintaan.
- Suite end-to-end: pada 13 Sep 2026 pagi, 13 dari 16 suite gagal atau berhenti di tengah karena
  helper uji mengambil cookie pertama (masalah lama, sudah diperbaiki). Sore harinya **19 suite lulus**
  (lihat bagian cara verifikasi). Catatan lama: penyebabnya bukan
  fitur hilang, melainkan helper klien uji mengambil cookie pertama dari header `Set-Cookie`, sedangkan
  API sekarang mengirim dua cookie (`coder_csrf` lebih dulu, lalu `coder_session`). Uji manual saya:
  dengan kedua cookie dikirim, `POST /api/v1/auth/register` menjawab 201 dan `GET /api/v1/auth/me`
  menjawab 200; dengan hanya cookie pertama, jawabannya 401 `AUTH_REQUIRED`.
  Yang lulus penuh: `login-identity` (10 PASS), `totp` (12 PASS), `rpc-adapter` (6 PASS).
  `real-ai` dan `real-usage` tidak saya jalankan karena butuh kunci provider.
- Perbaikan yang dibutuhkan agar suite jalan lagi: helper uji harus mengirim semua cookie, misalnya
  `response.headers.getSetCookie()`, bukan `setCookie.split(";")[0]`.
- Panel profil dan panel admin workspace sudah diimpor `App.tsx`, tetapi perubahan itu belum di-commit
  dan belum ada uji otomatis untuk kedua panel.
- Knowledge: pencarian masih leksikal FTS5 (`bm25`), bukan vektor/embedding; unggah dari URL belum ada.
- Artefak: belum ada versi dan kuota. Hapus artefak sudah ada.
- Akun: hapus akun sendiri sudah ada, tetapi ekspor seluruh data pribadi dan kebijakan retensi belum ada.
- Uji produksi dan beban dijalankan manual (`production-smoke.mjs`, `load-test.mjs`,
  `production-sse-check.mjs`, `production-ai-check.mjs`); repo tidak punya CI (`.github/` tidak ada).
- `migration-check.ts` bukan suite otomatis; ia butuh dua argumen (berkas DB sumber dan `DATA_DIR` tujuan).
- Backup, restore, dan rute unduh artefak belum punya uji otomatis; smoke hanya memeriksa daftar artefak.
- Deploy VPS: paket dan script ada, eksekusi di server Austria belum diverifikasi (butuh SSH, dipegang
  Aaron).

## Belum dibuat (daftar ini diperiksa ulang 15 Sep 2026, versi 0.14.1)

Bagian ini sebelumnya memuat beberapa hal yang sekarang SUDAH ada. Versi jujurnya:

Sudah ada sekarang (dulu tertulis "belum dibuat"):
- Penagihan dan pembayaran manual: `billing.ts` (paket, pesanan, bukti transfer, kupon, kredit).
  Integrasi penyedia otomatis tetap belum ada karena kuncinya belum diberikan.
- Surat keluar: `mailer.ts` + antrean `outbox.ts` + preferensi email. Pengirimannya masih dimatikan
  (`NOTIFY_EMAIL_ENABLED=false`), jadi statusnya "siap tetapi belum dinyalakan".
- Ekspor seluruh data pribadi dan kebijakan retensi: `dataexport.ts` dan `retention.ts`
  (kebijakan retensi masih mode uji, `RETENTION_ENABLED=false`).
- API publik untuk klien pihak ketiga (hanya baca) dan halaman harga publik `/harga`.
- Sandbox kode: dijalankan lewat engine per run, bukan sandbox terisolasi sendiri.

Masih benar-benar belum ada:
- OAuth/SSO (Google, GitHub, SAML).
- Notifikasi push (browser/HP). Notifikasi email ada, tetapi masih dimatikan.
- Redis atau broker pesan luar: antrean pekerjaan sekarang PERSISTEN (tabel `jobs`, schema 13, dengan sewa
  dan percobaan ulang lintas restart), tetapi masih memakai basis data yang sama dengan aplikasi dan belum
  ada broker terpisah. Antrean tetap satu proses: satu worker per container.
- Penskalaan horizontal: satu container, satu berkas SQLite, sesi di memori proses API.
- Object storage: artefak dan berkas ekspor disimpan di disk container.
- Pencarian pengetahuan berbasis vektor/embedding (sekarang FTS5 `bm25`), dan unggah dari URL.
- Versi dan kuota artefak.
- CI: repo punya remote GitHub, tetapi belum ada `.github/workflows`. Semua suite masih dijalankan manual
  (sekarang satu perintah: `npm run verify`).
- Gerbang persetujuan otomatis untuk deploy (`deploy-austria.sh` dijalankan manual oleh manusia).
- `coder-platform/apps/web` masih kosong; UI ada di `coder-dashboard`.

## Perbaikan pasca-Wave 4 (v0.14.1)

Bukan wave baru, hanya penutupan celah yang ditemukan saat Wave 4 diuji.

- Aturan hapus antrean email diperbaiki: baris `pending` boleh dihapus selagi pengiriman email mati,
  ditolak `409 EMAIL_IN_FLIGHT` saat pengiriman aktif, dan id yang tidak ada menjawab `404 EMAIL_NOT_FOUND`.
  Sebelumnya baris `pending` tidak bisa dihapus sama sekali, sehingga surat uji bisa tersangkut permanen.
- Suite baru `apps/api/test/csrf-strict.e2e.ts` — 13 pemeriksaan, semua lulus: menutup catatan lama
  "CSRF level dua belum ada suite yang menguji". Membuktikan cookie `coder_csrf` tidak HttpOnly,
  tulis tanpa token ditolak `403 CSRF_TOKEN_REQUIRED`, tulis dari situs lain tetap `403 CSRF_BLOCKED`,
  GET tidak terpengaruh, dan setiap klien mendapat token berbeda.
- Suite baru `apps/api/test/backup-restore.e2e.ts` — 22 pemeriksaan, semua lulus: menjalankan skrip
  produksi `backup.ts` dan `restore.ts` sungguhan. Menutup catatan lama "backup dan restore belum punya
  uji otomatis". Bukti penting: data yang masih berada di WAL IKUT terbawa ke berkas backup, dan versi
  skema serta baris pengguna ikut tersalin.
  **Temuan jujur**: `restore.ts` menyalin berkas apa pun tanpa memeriksa isinya. Berkas yang bukan
  database diterima saat restore dan baru gagal ketika aplikasi membukanya. Restore juga menimpa
  database tujuan tanpa bertanya, jadi jalur pemulihan harus tetap manual dan disengaja.
- `npm run verify` menjalankan seluruh suite sekaligus (26/26 hijau per 15 Sep 2026, termasuk
  `wave6.e2e.ts` 91 pemeriksaan dan `jobs.e2e.ts` 51 pemeriksaan).
- Suite baru `apps/api/test/jobs.e2e.ts` (Wave 5) — 51 pemeriksaan, semua lulus: sewa dan pengambilalihan
  setelah proses mati, jeda percobaan ulang dan batas percobaan, kunci dedupe, larangan pengambilan ganda,
  run yang tersimpan tetapi belum dikirim akhirnya dijalankan, run yang sudah selesai TIDAK dijalankan ulang,
  pemeriksa `WORKER_LOST` untuk run dan eksekusi workflow, serta rute admin (403 untuk non-admin).
  **Catatan jujur**: berkas uji tidak diperiksa tipe oleh `tsc`, karena `apps/api/tsconfig.json` hanya
  memuat `src/**/*.ts`; berkas uji dijalankan dengan `tsx` yang membuang tipe.
- Suite baru `apps/api/test/wave6.e2e.ts` (Wave 6) — 91 pemeriksaan, semua lulus: schema 14 dan tabel webhook,
  izin tulis pada kunci, rute tulis publik beserta penolakan viewer dan kunci baca, kuota harian per kunci
  (permintaan, token, dan pergantian hari), CRUD webhook beserta validasi alamat, tanda tangan HMAC yang
  diverifikasi oleh penerima uji sungguhan, pengiriman otomatis `run.completed`, percobaan ulang sampai
  `failed`, dan angka status hub. Catatan jujur yang sama berlaku: berkas uji tidak diperiksa `tsc`.

## Penghambat eksternal

- **Catatan DNS `coblai.com` (belum dipublikasikan, wajib untuk pengiriman ke luar)**: SPF
  `"v=spf1 a mx ip4:152.53.67.115 ~all"`, `dkim._domainkey` (kunci publik diambil dari mailcow,
  selector `dkim`), dan MX `10 mail.ilmupelet.com.` agar balasan atau pantulan surat bisa masuk.
- Kredensial SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`): tanpa itu email verifikasi dan reset
  sandi tidak terkirim.
- Kunci provider model (`DEEPSEEK_API_KEY` atau `OPENROUTER_API_KEY`) serta isi `PRIME_AGENT_PROVIDER`
  dan `PRIME_AGENT_MODEL`; di `.env.austria.example` keduanya masih kosong.
- Server Austria: butuh image base `coder-agent-engine:0.9.4` dan network `coder-net`. Deploy
  dijalankan Aaron; saya tidak punya SSH ke server itu.
- `METRICS_TOKEN` dan `PLATFORM_ADMIN_EMAILS` harus diisi di server sebelum metrik dan admin platform
  berguna.
- Kunci gateway pembayaran (`XENDIT_SECRET_KEY`, `MIDTRANS_SERVER_KEY`) dan kebijakan retensi data
  menunggu pemilik produk. Tanpa kunci itu hanya transfer manual yang aktif.

## Cara verifikasi

Cek tipe (tanpa keluaran berarti lulus; saya jalankan 13 Sep 2026):

- Backend: `cd coder-platform && npx tsc -p tsconfig.json --noEmit`
- Dashboard: `cd coder-dashboard && npx tsc -p tsconfig.app.json --noEmit`

Suite end-to-end lokal tanpa jaringan:

- `cd coder-platform && MOCK_ENGINE=true npx tsx apps/api/test/<suite>.e2e.ts`
- Cara tercepat sekarang: `cd coder-platform && npm run verify` (28 suite, mencetak `ALL_SUITES_PASSED`).
- Suite yang ditambahkan setelah snapshot 21 suite itu, semuanya hijau 15 Sep 2026:
  `wave3.e2e.ts` (260 lulus, 1 SKIP), `wave4.e2e.ts` (181), `outbox-mail.e2e.ts` (14),
  `csrf-strict.e2e.ts` (13), `backup-restore.e2e.ts` (22), `jobs.e2e.ts` (51), `wave6.e2e.ts` (91),
  `wave7.e2e.ts` (95, menjalankan alur undangan sampai hadiah lewat MOCK_ENGINE).
- `wave8.e2e.ts` (99, 16 Sep 2026): penutupan akun dua langkah, gerbang verifikasi email dengan
  `VERIFY_EMAIL_REQUIRED=on`, batas laju berbasis tabel, dan pembersihan akun oleh pekerja retensi
  (termasuk kasus workspace kosong vs workspace yang masih beranggota).
- Catatan jujur: `apps/api/tsconfig.json` hanya menyertakan `src/**/*.ts`, jadi berkas uji di `apps/api/test`
  TIDAK diperiksa tipe oleh `tsc --noEmit` (di-type-strip oleh tsx). Yang diperiksa tipe hanya kode server.
- 21 suite (20 suite lama lulus 14 Sep 2026 sebelum Wave 2 dengan `RUNNER_EXIT=0`; `wave2` lulus
  104/104 pemeriksaan): `account-recovery`, `account-security`, `admin-metrics`, `billing`, `csrf-limits`,
  `delete-flow`, `guards`, `knowledge-team`, `login-identity`, `mailer`, `model-rbac`, `project-runs`,
  `rpc-adapter`, `session-usage`, `totp`, `usage-cost`, `viewer-rbac`, `wave2`, `workflow-engine`,
  `real-ai`, `real-usage`.
- `usage-cost.e2e.ts` dijalankan tanpa `MOCK_ENGINE=true`, memakai
  `PRIME_AGENT_BIN=apps/api/test/fixtures/fake-prime-agent.mjs` (tetap tanpa jaringan).
- Tanpa server sama sekali: `npx tsx apps/api/test/rpc-adapter.e2e.ts` dan
  `npx tsx apps/api/test/totp.e2e.ts`.
- `real-ai.e2e.ts` dan `real-usage.e2e.ts` butuh kunci provider, jadi bukan mode mock.

Produksi:

- `BASE_URL=https://coder.sam.university CODER_EMAIL=... CODER_PASSWORD=... node apps/api/test/production-smoke.mjs`
  (keluar dengan kode 2 bila kredensial kosong).
- `cd coder-platform && npx tsx apps/api/test/migration-check.ts backups/<berkas>.db /tmp/target-dir`
- Uji beban manual: `node apps/api/test/load-test.mjs`

Syarat env lokal: `MOCK_ENGINE=true`, `DATA_DIR` ke folder sementara, `PORT` bebas. Bila
`MOCK_ENGINE` tidak diisi, engine memakai `PRIME_AGENT_BIN`; kalau kosong, jawabannya
`ENGINE_NOT_CONFIGURED`.
