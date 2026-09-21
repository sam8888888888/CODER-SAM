# Status implementasi COBLAI Coder

Terakhir diperbarui: 21 Sep 2026 (versi **0.20.1 LIVE** di server Austria; **v0.20.2 sudah selesai dan teruji di lokal, belum di-deploy** karena deploy/restart produksi menunggu izin Bapak. Butir 15b, 19, dan 20 selesai di kode; rinciannya di bagian "v0.20.2" di bawah.)

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

## v0.20.2 (21 Sep 2026) — butir 15b, 19, 20 — SELESAI DI KODE, BELUM DEPLOY

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
