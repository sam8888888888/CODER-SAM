# DAFTAR MASALAH & PEKERJAAN TERTUNDA — COBLAI Coder (coder.sam.university)

Dikumpulkan atas perintah Bapak: "SEMUA MASALAH DAN YANG BELUM BERES, DIKUMPULKAN,
NANTI TERAKHIR KITA BERESKAN SATU PER SATU."

Versi platform saat daftar ini diperbarui: **v0.20.1 (Wave 10 penuh + perbaikan dashboard butir 41)**. | CATATAN 26 Sep 2026: Wave 11A (butir 42-57, 79, 80) sudah **selesai di kode, BELUM di-deploy** (v0.21.0, skema 19). Lihat bagian "6. WAVE 11" di bawah.
Legenda status: [BAPAK] butuh keputusan/izin Bapak · [TEKNIS] pekerjaan teknis yang bisa saya kerjakan ·
[FITUR] fitur yang belum ada · [RISIKO] temuan yang berpotensi berbahaya.

---

## 0. STATUS KEPUTUSAN BAPAK (jawaban bertahap, 16 Sep 2026)

Keputusan yang sudah diterima (butir 1-5) dan hasilnya di produksi:

| Butir | Keputusan Bapak | Status | Bukti |
|-------|-----------------|--------|-------|
| 1 | Nyalakan email notifikasi | SELESAI | `NOTIFY_EMAIL_ENABLED=true` di `.env` produksi; restart; surat uji ke `noreply@coblai.com` MASUK ke kotak (subjek "Verifikasi email COBLAI Coder"); smoke 156 lulus |
| 2 | Retensi 12 bulan + akun bisa dihapus sendiri | SELESAI | `RETENTION_ENABLED=true`, audit 365 h, notifikasi 365 h, run_events 365 h, ekspor 30 h, token kedaluwarsa 1 h; hapus akun sendiri SUDAH ADA (Profil -> Hapus akun) dan diuji nyata di produksi (`{"ok":true,"deletedWorkspaces":1}`) |
| 3 | Bapak memasang DNS sendiri | TINDAK LANJUT BAPAK | Rincian dikirim: `docs/DNS_COBLAI_COM.md` (MX, SPF, DKIM) |
| 4 | Pakai Midtrans saja | SEBAGIAN | Kunci produksi tersimpan di `.env` produksi dan tervalidasi ke API Midtrans (Snap menjawab 400 validasi = kunci sah; sandbox menolak 401). Penagihan otomatis (pembuatan transaksi Snap + verifikasi tanda tangan webhook) BELUM ada -> pekerjaan berikutnya; gateway masih `manual` |
| 5 | Matikan tombol Google | SELESAI | Tidak ada tombol "Masuk dengan Google" di UI (hanya nama aplikasi authenticator) |

Butir 1, 2, 5 tidak lagi masuk daftar tunggu. Butir 3, 4 masih berjalan sebagian (DNS menunggu
Bapak; penagihan otomatis Midtrans belum dibangun).

Keputusan Bapak untuk butir 6-15 sudah diterima dan dikerjakan sebagai Wave 8 (v0.18.0):

| Butir | Keputusan Bapak | Status | Bukti |
|-------|-----------------|--------|-------|
| 6 | Akun bisa ditutup sendiri, data disimpan 90 hari, wajib ekspor dulu | SELESAI (kode + uji) | `DELETE /api/v1/auth/account` = penutupan lunak; `409 EXPORT_REQUIRED` tanpa ekspor ≤24 h; `deleted_at` + `purge_after` = +90 hari; `403 ACCOUNT_DELETED` saat masuk; admin `POST /api/v1/admin/users/:id/restore`; pekerja `retention.run` menghapus baris dan berkasnya; `wave8.e2e.ts` bagian 4-6 |
| 7 | Verifikasi email wajib untuk aksi AI | SELESAI (kode + uji) | `403 EMAIL_NOT_VERIFIED` pada run, eksekusi workflow, dan pembuatan kunci API; mode `VERIFY_EMAIL_REQUIRED=auto/on/off` (auto = ikut status server email); `/auth/me` melaporkan `emailVerified`; `wave8.e2e.ts` bagian 3 (mode `on`) |
| 8 | Hadiah rujukan 500.000 / 250.000 token | DIKONFIRMASI, tidak berubah | nilai sama seperti Wave 7; hadiah hanya setelah run pertama yang diundang selesai |
| 9 | CSRF ketat | MENUNGGU KEPUTUSAN | penjelasan di `docs/CSRF_STRICT.md`; `CSRF_STRICT` masih `false` |
| 10 | Admin kedua + admin boleh ubah email/kata sandi | SELESAI (kode + uji + PRODUKSI) | `PATCH /admin/users/:id` menerima `email` (verifikasi direset), `POST /admin/users/:id/password` (sandi otomatis mudah dibaca, ditampilkan sekali, semua sesi dicabut), `POST /admin/users/:id/restore`; PRODUKSI: `samian@sam.university` dibuat (enterprise, admin, terverifikasi) + `PLATFORM_ADMIN_EMAILS` diperbarui → `security.adminEmails=2`; `wave8.e2e.ts` bagian 7 |
| 11 | Prune image Docker | SELESAI (aman) | 16 Sep 2026: 14 tag lama `coder-platform-app` (0.9.3–0.16.0) dihapus (0.17.0 disimpan untuk rollback), `builder prune -f` = 222,7 MB, `image prune -f` = 14 kB (dangling lain dipakai proyek lain → dilewati otomatis); `-a`/container/volume prune TIDAK dijalankan; `/tmp/node-compile-cache` bukan milik kita (dilewati) |
| 12 | Hapus entri audit uji | SELESAI | 16 Sep 2026: 980 baris jejak uji dihapus (48 ruang kerja Bapak + 932 ruang kerja smoke.bot), 34 baris keamanan global dipertahankan + 1 baris catatan `admin.audit_cleanup`; cadangan dibuat lebih dulu |
| 13 | Push ke GitHub | TERHALANG | tidak ada kredensial GitHub; `deploy/*.tar.gz` + `.sha256` SUDAH dikeluarkan dari git + `.gitignore`; pemindaian paket deploy dan riwayat git bersih (tidak ada `.env`/`.db`/`.pem`); butuh fine-grained PAT `contents: write` atau deploy key |
| 14 | Batasi relay mailcow | SELESAI | 16 Sep 2026: port publik 25/465/587 wajib SMTP AUTH (port internal 588 dst. dibiarkan); bukti sebelum `250 Ok` → sesudah `454/554 Relay access denied`; jalur sah aplikasi tetap `status=sent`; cadangan `master.cf.bak_20260916_1516` + skrip rollback; detail `docs/PATCH_MAILCOW_RELAY.md` |
| 15 | Batas laju pindah ke basis data | SELESAI (kode + uji) | tabel `rate_limit_hits`, kunci berawalan nama aturan, jendela geser, sapuan tiap menit; `status-hub.openPlatform.rateLimits.store = "database"`; `wave8.e2e.ts` bagian 1-2 |

Rincian lengkap: `docs/PLAN_WAVE_8.md`.

Keputusan Bapak untuk butir 16-20 sudah diterima dan dikerjakan sebagai Wave 9 (v0.19.0):

| Butir | Keputusan Bapak | Status | Bukti |
|-------|-----------------|--------|-------|
| 16 | `--force-recreate` diizinkan; tanpa henti layanan boleh dicoba | SELESAI (kode + uji) | `docker-compose.austria.yml` memakai satu anchor `x-app` untuk biru (3402), hijau (3403, profil `green`), dan worker; `deploy/deploy-austria.sh` menjalankan `point_nginx` + `wait_ready`; kalau pola nginx tidak ada → `ZERO_DOWNTIME_SKIPPED` dan kembali ke cara lama; log deploy memuat `READY 3403`, `NGINX_POINTED 3403`, `NGINX_POINTED 3402`, `ZERO_DOWNTIME_DONE`; volume baru `coder-platform-engine-sessions` membuat sesi mesin bertahan lintas deploy |
| 17 | Antrean di proses sendiri boleh, asal rapi | SELESAI (kode + uji) | `apps/api/src/worker.ts` + `JOB_WORKER_IN_WEB`/`WORKER_ONLY` di `config.ts`; wadah `coder-platform-worker` menjalankan `node dist/api/worker.js` tanpa port; `apps/api/test/worker-split.e2e.ts` 17/17 lulus (`ALL_WORKER_SPLIT_TESTS_PASSED`) |
| 18 | Alat periksa migrasi boleh jalan tiap deploy, harus benar | SELESAI (kode + uji) | `apps/api/src/migration-rehearsal.ts` ada di dalam citra; dijalankan atas cadangan produksi terbaru di wadah sekali pakai (volume data hidup TIDAK dipasang); gagal → `DEPLOY_ABORTED`; `migration-check.ts` jadi pembungkus tipis dan gerbang pertama `run-all.cjs`; dua mode lulus (`MIGRATION_REHEARSAL_OK`, `INTEGRITY_CHECK ok`, `ROW_COUNTS_PRESERVED true`, `REOPEN_IDEMPOTENT true`) |
| 19 | Kolom harga asli per 1 juta token + faktor markup | SELESAI (kode + uji + PRODUKSI) | `apps/api/src/pricing.ts`; `cost_micros` = harga pokok (tidak pernah disentuh markup), `sell_cost_micros` = `round(cost x markup)`; rute `GET/PUT/DELETE /api/v1/admin/pricing[...]`; halaman `Harga AI` di dashboard; `pricing.e2e.ts` 130 lulus / 0 gagal / 0 lewat; `render-check-wave9.tsx` `ALL_WAVE9_PAGES_RENDERED`; blok `aiPricing` di smoke produksi |
| 20 | Periksa dan uji pengatur waktu pembaruan TLS | SELESAI (diperiksa) | `systemctl is-active certbot.timer` = `active`; sertifikat berlaku ±85 hari; `certbot renew --dry-run` = "all simulated renewals succeeded"; tidak ada perubahan konfigurasi |

Rincian lengkap: `docs/PLAN_WAVE_9.md`.

## 1. MENUNGGU KEPUTUSAN BAPAK

1. [BAPAK] Aktifkan pengiriman email (`NOTIFY_EMAIL_ENABLED=false`). SMTP sudah terpasang dan
   pernah diuji end-to-end, tetapi masih mati; akibatnya email reset sandi/verifikasi hanya
   masuk antrean.
2. [BAPAK] Aktifkan retensi otomatis (`RETENTION_ENABLED=false`) atau tetapkan kebijakan lama
   simpan data (pesan, artefak, ekspor, riwayat pengiriman webhook).
3. [BAPAK] Publikasikan DNS `coblai.com`: SPF, DKIM (kunci publik sudah diekstrak), dan MX.
   Tanpa ini email dari `noreply@coblai.com` berisiko masuk spam.
4. [BAPAK] Kunci gateway pembayaran (Xendit/Midtrans). Tanpa kunci, aktivasi paket ditolak
   `400 GATEWAY_NOT_CONFIGURED`; pembayaran hanya bisa manual lewat transfer + bukti.
5. [BAPAK] Google OAuth client id/secret bila ingin tombol "Masuk dengan Google" berfungsi.
6. [SELESAI] Kebijakan hapus akun: pengguna menutup sendiri, masa pemulihan 90 hari, wajib
   ekspor dulu. Dijawab Bapak dan dibangun di Wave 8.
7. [SELESAI] Verifikasi email wajib sebelum aksi AI. Dijawab Bapak dan dibangun di Wave 8.
8. [BAPAK] Batas hadiah program rujukan: besaran token untuk pengundang dan yang diundang
   (sekarang usulan awal 500.000 / 250.000 token, dapat diubah lewat env).

## 2. MENUNGGU IZIN BAPAK (aksi berisiko di produksi)

9. [BAPAK] Nyalakan `CSRF_STRICT` di produksi (sekarang hanya lapisan Origin/Sec-Fetch-Site).
10. [SEBAGIAN] Admin kedua: kode dan uji selesai (Wave 8). Sisa: menambahkan email admin kedua
    ke `PLATFORM_ADMIN_EMAILS` di `.env` produksi lalu restart. Menunggu email mana yang dipakai
    dan izin restart.
11. [BAPAK] Prune image Docker milik proyek lain (30,58 GB reclaimable) — bukan milik COBLAI.
12. [BAPAK] Hapus 561 baris `audit_events` jejak uji di workspace Bapak (jejak audit, jadi
    menunggu izin).
13. [BAPAK] Push repository ke GitHub (`github.com/sam8888888888/coblai-dinda`) — belum pernah
    di-push. **Diperiksa 26 Sep 2026:** ruang kerja tidak punya kredensial GitHub (tidak ada
    `~/.git-credentials`, tidak ada `credential.helper`, tidak ada kunci SSH GitHub,
    `GIT_ASKPASS=true`). `git ls-remote origin` menjawab `remote: Repository not found.` +
    `fatal: Authentication failed`. Butuh token akses (Personal Access Token) dari Bapak; sesudah itu
    push hanya satu perintah.
14. [BAPAK] Batasi `mynetworks` relay mailcow (temuan 14 Sep: relay menerima surat tanpa
    autentikasi dari jaringan lokal host).
15. [SELESAI 26 Sep 2026] Samakan CSP nginx peladen dengan CSP aplikasi + blok `location` artefak —
    dijalankan setelah Bapak mengizinkan; hasil dan buktinya di §6.7.
16. [SELESAI 26 Sep 2026] Smoke produksi berkredensial — akun uji dibuat sendiri atas izin Bapak,
    **202 lulus / 0 gagal**, lalu akun ditutup lewat jalur resmi. Rincian di §6.7.

## 3. UTANG TEKNIS

15. [SELESAI] Batas laju kini disimpan di tabel `rate_limit_hits` (Wave 8), jadi tahan restart
    dan aman untuk banyak replika. Cara lama (memori proses) sudah tidak dipakai.
15b. [SELESAI — v0.20.2] Sapuan tabel `rate_limit_hits` kini dijalankan pekerja terjadwal:
    jenis pekerjaan `ratelimit.sweep` dijadwalkan tiap 5 menit di `jobs.ts`. Sapuan malas di proses
    web dimatikan lewat `RATE_LIMIT_SWEEP_IN_WEB=false` (bawaan `true` untuk pemasangan satu proses;
    produksi menyetel `false`). Uji: `apps/api/test/ratelimit-sweep.e2e.ts` 22/22 lulus.
16. [SELESAI] Wave 9 memasang tukar hijau-biru: profil `green` di `coder-platform/docker-compose.austria.yml`
    plus `point_nginx`/`wait_ready` di `deploy/deploy-austria.sh` (hijau melayani port 3403 selagi biru
    dibuat ulang). Terbukti saat deploy v0.19.0 (smoke produksi 176 lulus).
17. [SELESAI] Antrean kini punya proses/wadah sendiri: layanan `coder-platform-worker` di
    `coder-platform/docker-compose.austria.yml`, dan produksi memakai `JOB_WORKER_IN_WEB=false` sehingga
    proses web tidak mengambil pekerjaan. Redis/broker tetap belum ada; itu pekerjaan baru bila nanti
    butuh banyak pekerja.
18. [SELESAI] `migration-check.ts` sekarang ikut runner suite sebagai gerbang migrasi (`runMigrationGate()`
    di `apps/api/test/run-all.cjs`), jadi pemeriksaan skema selalu ikut `npm run verify`.
19. [SELESAI — v0.20.2] Angka biaya AI kini mengikuti daftar harga RESMI DeepSeek. Katalog mesin
    (`model-prices.ts`) adalah berkas generated yang memuat harga `deepseek-v4-flash` 0,14/0,28 dan
    `deepseek-v4-pro` 0,435/0,87 per 1 juta token; harga resmi (21 Sep 2026) adalah 0,15/0,60 dan
    0,66/1,98, dengan tarif puncak dua kali pada 01:00–04:00 dan 06:00–10:00 UTC hari kerja.
    Berkas baru `apps/api/src/vendor-prices.ts` memuat harga resmi berstempel tanggal; urutan sumber
    harga: harga sendiri (pemilik) → harga resmi vendor → katalog mesin.
    Rekonsiliasi data produksi 13–19 Sep 2026 (baca saja): `run_usage` 29 pemakaian tercatat
    5.152 mikrodolar, seharusnya 8.023 mikrodolar (selisih +2.871, +55,7%); `user_usage` (playground)
    tercatat 11.501, seharusnya 15.979 (+38,9%); gabungan 16.653 → 24.002 mikrodolar (+44,1%).
    Rute baru `GET /api/v1/admin/pricing/reconcile` dan kartu "Rekonsiliasi biaya AI" di halaman
    Konsol Harga menampilkan selisih itu kapan saja. Saldo DeepSeek saat diperiksa: 71,13 USD.
20. [SELESAI (diperiksa) — v0.20.2] Timer pembaruan TLS sudah diverifikasi tanpa mengubah server:
    `certbot.timer` aktif + enabled, jalan 2x sehari (`OnCalendar=*-*-* 00,12:00:00`), dan 10 eksekusi
    terakhir tercatat di jurnal. Sertifikat `coder.sam.university` berlaku sampai 11 Des 2026 dan
    sertifikat yang disajikan nginx identik dengan yang ada di disk; uji kering untuk sertifikat ini
    BERHASIL. Laporan lengkap: `/workspace/LAPORAN_BUTIR20_CERTBOT.md`.
20b. [SELESAI 21 Sep 2026 malam — 1 poin kecil menunggu keputusan Bapak] Beres-beres sertifikat:
    (a) [SELESAI 21 Sep 2026 malam, atas izin Bapak] Kelima domain diperiksa ulang lalu dibereskan.
    Bukti rinci: `/workspace/LAPORAN_BUTIR20B_SERTIFIKAT_v2.md`.
        - `cover.sam.university` (DNS NXDOMAIN = sudah mati) → vhost
          `/etc/nginx/sites-enabled/cover.sam.university.conf` DIHAPUS dan sertifikatnya DIHAPUS.
        - `kampus.sam.university` (DNS NXDOMAIN = sudah mati) → symlink sites-enabled + berkas
          `sites-available/kampus.sam.university.conf` (+ tambahan `.bak_20260904_123144`) DIHAPUS;
          sertifikatnya DIHAPUS.
        - `inventory.coblai.com` → vhost DIHAPUS (symlink sites-enabled + berkas sites-available).
          CATATAN JUJUR: premis awal kami SALAH — kami kira vhost itu tidak aktif, karena `grep -r`
          tidak mengikuti symlink. Nyatanya vhost itu AKTIF dan mengalihkan 301 ke
          `https://rena.coblai.com`. Akibatnya sekarang `https://inventory.coblai.com` gagal TLS
          (nginx menyajikan sertifikat default `blog.crossbordermarketplace.com` yang tidak cocok
          dengan nama itu); lewat :80 dijawab server default. Pembaruan sertifikat domain itu justru
          kini BERHASIL. Menunggu keputusan Bapak: hidupkan lagi 301-nya (dengan lokasi acme-challenge
          ditambahkan) atau biarkan mati.
        - `sam.university` → DIPERBAIKI. Lokasi `/.well-known/acme-challenge/` ditambahkan ke blok :443:
          `location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }`. `proxy_pass` ke
          `127.0.0.1:2369` tidak disentuh; situs tetap 200.
        - `rena.coblai.com` → DIPERBAIKI dengan pola yang sama. `root /www/wwwroot/rena.coblai.com`
          dan aturan `try_files` tidak disentuh; situs tetap 200.
      Hasil `certbot renew --dry-run` sesudah perbaikan: **24 pembaruan simulasi BERHASIL** (termasuk
      `coder.sam.university`, `sam.university`, `rena.coblai.com`, `inventory.coblai.com`) dan
      **1 GAGAL**: `geoauthorityengine.com` (proyek lain) dengan galat `Unable to update challenge ::
      authorization must be pending`. Domain itu bukan milik platform ini dan termasuk yang Bapak
      larang disentuh, jadi dibiarkan dan diteruskan sebagai laporan. Sertifikat tersisa di server: 25.
      Cadangan sebelum perubahan: `/root/backup-nginx-20260921/nginx-letsencrypt-backup.tar.gz`
      (sites-enabled + sites-available + seluruh /etc/letsencrypt termasuk kunci privat; 432 entri).
      `nginx -t` OK dan `systemctl reload nginx` OK sesudah semua perubahan; `/health` = 200.
      Catatan bukti trafik: nginx ini tidak punya `log_format` khusus, jadi log akses tidak memuat
      kolom nama domain — hitungan trafik per domain tidak bisa diberikan dan tidak kami karang.
      Bukti sahih untuk cover/kampus adalah DNS NXDOMAIN: nama yang tidak bisa di-resolve mustahil
      menerima trafik HTTP.
    (b) [SELESAI 21 Sep 2026, atas izin Bapak] Symlink sisa `coder.sam.university.conf.bak_20260920_091515`
    di `/etc/nginx/sites-enabled/` SUDAH DIHAPUS. Sebelum dihapus dibuktikan dulu bahwa symlink itu
    menunjuk berkas yang sama dengan `coder.sam.university.conf`, sehingga blok server itu dimuat dua kali.
    Sesudah dihapus: `nginx -t` OK, `systemctl reload nginx` OK, jumlah `server_name coder.sam.university`
    di `nginx -T` turun dari 4 menjadi 2, dan peringatan "conflicting server name coder.sam.university"
    hilang. Kesehatan `https://coder.sam.university/health` = 200 sesudah reload. Sisa 8 peringatan
    "conflicting server name" di server ini milik proyek lain (`crossbordermarketplace.com`,
    `geoauthorityengine.com`) dan tidak kami sentuh.
    (c) Tidak ada hook pasca-pembaruan untuk memuat ulang nginx; untuk sertifikat coder hal itu tidak
    perlu karena certbot memakai installer nginx dan menjalankan reload sendiri.
21. [SELESAI] Berkas uji sekarang diperiksa tipe: `tsconfig.test.json` (akar `coder-platform`, memuat
    `apps/api/test/**/*.ts`) dijalankan lewat `npx tsc -p tsconfig.test.json` sebagai gerbang PERTAMA
    `apps/api/test/run-all.cjs`; semua galat tipe suite lama sudah diperbaiki, bukan dimatikan.
    Terbukti: baris `tsconfig.test.json` muncul di `npm run verify` (39/39 suite hijau, 18 Sep 2026).
22. [SELESAI] Ada uji UI otomatis di peramban: `playwright` (devDependency `coder-dashboard`) + suite
    `coder-dashboard/e2e/ui.e2e.mjs` yang menyajikan `dist/` hasil `vite build` dan mengklik alur nyata
    (daftar akun, masuk, semua halaman Wave 10 lewat menu, cari global, halaman admin, service worker
    push). Jalankan `cd coder-dashboard && npm run e2e` (`npm run e2e:full` membangun `dist/` dulu) atau
    `npm run test:ui` dari `coder-platform`. Terbukti 28/28 lulus, 0 gagal, 0 lewat, keluar 0.
23. [SELESAI] Webhook: kolom `sequence` (monoton per webhook) dan `resend_of` + jaminan urutan
    (pengiriman berikutnya `deferred` selama kiriman lebih awal masih menunggu, batas
    `MAX_ORDER_DEFERRALS`), rute kirim ulang `POST /api/v1/webhooks/:id/deliveries/:deliveryId/resend`
    (jawab 201), tabel riwayat + tombol kirim ulang di halaman Webhook, pembersihan otomatis lewat
    retensi (`RETENTION_WEBHOOK_DAYS`, bawaan 30) plus tombol bersihkan-sekarang dengan mode kering.
    Terbukti `webhook-order.e2e.ts` 64/64.
24. [SELESAI] `runs.reserved_tokens` diisi saat run dari kunci API dimulai, dan `apiKeyUsageToday()`
    menghitung token run `queued`/`running`. API menampilkan cadangan itu: setiap kunci pada
    `GET /api/v1/api-keys` membawa `tokensReserved`, `quota.tokensReserved`, dan `inFlight[]`; totalnya
    di `GET /api/v1/status-hub` (`housekeeping.reservedTokensWaiting`). Terbukti `wave10.e2e.ts`
    137/137, `apikey-inflight.e2e.ts` 53/53, dan smoke produksi 18 Sep 2026.
    Catatan jujur: klaim lama "UI menampilkan `inFlightTokens`" tidak terbukti — dashboard belum
    menampilkan angka ini di halaman Kunci API (masuk butir 41).
25. [SELESAI] `backfillGrowthEvents()` mengisi ulang `growth_events` dari tabel asli (`created_at`
    asli, `source='backfill'`), idempoten, punya mode kering dan mode terapkan, dan bisa dipicu admin
    (`GET`/`POST /api/v1/admin/growth/backfill`). Terbukti `growth-backfill.e2e.ts` 70/70.
26. [SELESAI] Anti-penyalahgunaan rujukan kini tiga gerbang: `SAME_EMAIL`, `SAME_IP`, dan `SAME_DEVICE`
    (tabel `user_devices` + `auth_sessions.device_id`), dan hadiah hanya dibayar bila email undangan
    sudah diverifikasi (`REFERRAL_REQUIRE_VERIFIED_EMAIL`).
27. [SELESAI] Smoke: `SMOKE_KEEP_DATA=1` untuk melewati pembersihan, mode kering retensi
    (`RETENTION_DRY_RUN`), dan pekerjaan berkala `smoke.cleanup` (`SMOKE_CLEANUP_ENABLED`,
    `SMOKE_CLEANUP_HOURS`, bawaan mati = hanya melaporkan). Pembersihan sungguhan baru berjalan setelah
    diaktifkan di `.env` produksi.
28. [SELESAI] Halaman "Metrik" di UI + `GET /api/v1/admin/metrics` (JSON, sesi admin) dan isian token
    untuk mengambil teks Prometheus mentah. `/metrics` tanpa token tetap menjawab 404 tanpa keterangan.
29. [SELESAI] `GET /api/v1/search` lintas proyek (FTS5 `message_search` + FTS knowledge + `LIKE` untuk
    proyek, percakapan, artefak, workflow) dengan kotak cari global di UI. Terbukti `wave10-search.e2e.ts`
    70/70 dengan 0 lewat.
30. [SELESAI] Keputusan tetap: Bahasa Indonesia saja, tanpa i18n — ditulis di
    `docs/KEPUTUSAN_BAHASA_INDONESIA.md` dan dijaga `wave10-bahasa.e2e.ts` (14/14).
31. [SELESAI] Email (SMTP) + Web Push peramban: `apps/api/src/push.ts` (kunci VAPID disimpan di
    `platform_settings`, langganan di `push_subscriptions`), service worker `public/push-sw.js`, tombol
    aktif/nonaktif di Pengaturan, dan rute uji kirim. Email tetap mengikuti `NOTIFY_EMAIL_ENABLED`
    (bawaan `false`).
32. [SELESAI] `deploy/env.keys.txt` (daftar resmi 76 kunci + bagian `#usang`) dan `deploy/env-sync.sh`
    dipanggil `deploy/deploy-austria.sh`: menambah key yang hilang beserta nilai bawaannya, TIDAK pernah
    menimpa nilai lama, melaporkan `ENV_OBSOLETE_KEYS`/`ENV_UNKNOWN_KEYS`/`ENV_MISSING`/`ENV_ADDED`,
    cadangan bernomor, idempoten, tanpa `eval`/`source`/`sed -i`, dan hanya mencetak NAMA key. Terbukti
    `deploy-env-sync.e2e.ts` 70/70. Temuan: `PLATFORM_WEBHOOK_URL` sudah tidak dibaca kode (masuk bagian
    usang) dan enam key yang dibaca kode belum ada di `.env.austria.example` (sudah ditambahkan).
32b. [SELESAI] Pemeriksaan perangkat sudah ada: `SAME_DEVICE` (perangkat sama tidak bisa saling
    merujuk) plus halaman "Perangkat & sesi" (lihat, ubah nama, tandai tepercaya, cabut) dan notifikasi
    perangkat baru. Hanya itu yang diaktifkan; `DEVICE_VERIFY_NEW` tetap `off` supaya tidak ada risiko
    akun terkunci.
32c. [SELESAI] Backfill sudah ada (lihat butir 25): grafik aktivitas harian bisa diisi surut lewat
    `POST /api/v1/admin/growth/backfill` (idempoten, ada mode kering), sedangkan corong tetap berlaku
    surut karena dibaca dari tabel asli.
32d. [SELESAI] Ada suite UI di peramban (Playwright/Chromium terpasang lewat devDependency dashboard),
    jadi halaman baru diuji dengan klik nyata — bukan hanya `render-check-wave7.tsx` + tsc.
33. [FITUR] Integrasi pihak ketiga (mis. GitHub, Slack) selain webhook keluar.
34. [FITUR] Multimodal (unggah gambar/audio untuk percakapan) — lampiran saat ini hanya berkas
    teks.
35. [FITUR] Verifikasi nomor HP / 2FA SMS (TOTP sudah ada).
36. [FITUR] Paket tim/perusahaan dengan kursi berbayar otomatis (billing per anggota).
37. [FITUR] Pusat bantuan/tiket dukungan di dalam aplikasi.

## 5. RISIKO YANG DIPANTAU

38. [RISIKO] Satu admin platform (risiko terkunci). Penjaga LAST_ADMIN ada, tapi tetap titik
    tunggal.
39. [RISIKO] Verifikasi alamat webhook tidak memakai resolusi DNS -> domain yang menunjuk IP
    privat belum diblokir; metadata `169.254.169.254` dan localhost sudah diblokir.
40. [RISIKO] Disk server kerja sering penuh (pernah 99%) -> suite uji bisa gagal `SQLITE_FULL`.
    Perlu pembersihan berkala direktori uji di `/tmp`.
41. [SELESAI] Halaman "Kunci API" dulu membaca `row.lastUsedIp`, padahal `GET /api/v1/api-keys`
    mengirim `lastIp`; kolom "IP terakhir" kosong sejak Wave 4 (v0.14.1). Sekarang dibaca `lastIp`,
    dan tabel mendapat kolom baru "Token run berjalan" (`tokensReserved`, jumlah run berjalan, sisa
    kuota token hari ini) untuk melengkapi butir 24. Bukti: uji UI peramban 33/33 `UI_E2E_PASSED`
    (termasuk "halaman Kunci API menampilkan IP terakhir yang dicatat server"), produksi LIVE
    `0.20.1`, smoke produksi 199 lulus / 0 gagal, dan bundel LIVE memuat label kolom barunya.

## 6. WAVE 11 (butir 42–83) — PRD `PRD_WAVE_11_EKSEKUSI_v5.md`

Sumber: PRD Wave 11 versi 5 (25 Sep 2026), **42 butir** (42–83), dikerjakan bertahap:
**11A → v0.21.0 · 11B → v0.22.0 · 11C → v0.23.0**. Bagian ini menggantikan cara nomor 42–83
disebut satu per satu; rincian bukti ada di `docs/STATUS.md` bagian "Wave 11A".

### 6.1 Wave 11A (v0.21.0) — SELESAI DI KODE, SUDAH LIVE (26 Sep 2026)

18 butir: 42, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 57, 79, 80 — dan 50 TERTAHAN.
Gerbang: `npm run verify` hijau (44/44 suite), skema 18 → 19, suite baru 176 + 127 + 84 + 187 =
**574 pemeriksaan API**, uji UI peramban **97/97 lulus**.

| # | Butir | Status | Bukti singkat |
|---|-------|--------|---------------|
| 42 | Mode diskusi/eksekusi | SELESAI (kode+uji); 1 bagian DoD butuh mesin nyata | `wave11a §1` 15; blok mode prioritas 0 terkirim ke mesin |
| 43 | Enkripsi rahasia at-rest | SELESAI | `wave11a-rahasia §1+§2` 65; teks asli tidak ada di DB/jawaban |
| 44 | Isolasi kredensial antar-sesi | SELESAI | `wave11a-rahasia §3` 20 + `wave11a §3b` 7 |
| 45 | Filter anti prompt-hijack | SELESAI | `wave11a §4` 20; 10 serangan diblokir, 10 kalimat wajar lolos |
| 46 | Guardrails | SELESAI | `wave11a §5` 24 + uji UI panel pelanggaran |
| 47 | Kebijakan alat | SELESAI (bawaan kosong = semua alat, lihat catatan) | `wave11a §6` 14 + uji UI halaman |
| 48 | Tulis-balik artefak + riwayat | SELESAI | `wave11a-artefak` 84 + uji UI 4 |
| 49 | Preview Word/Excel/PowerPoint | SELESAI | uji UI 8 (docx/xlsx/pptx/md, >10 MB, docx rusak) |
| 50 | Generasi & edit/gabung gambar | TERTAHAN sesuai PRD | — |
| 51 | Skill pengguna | SELESAI | `wave11a §7` 18 |
| 52 | Knowledge base platform | SELESAI | `wave11a §8` 15 |
| 53 | Audit-diri kredensial | SELESAI | `wave11a-rahasia §4` 39 + uji UI kartu Kesehatan platform |
| 54 | Hapus semua riwayat | SELESAI | `wave11a §10` 16 + uji UI 4 |
| 55 | Tombol instal HP + panduan iOS | SELESAI | uji UI 6 |
| 56 | Playground kalkulator biaya | SELESAI | `wave11a §11` 9 |
| 57 | Fallback model otomatis | SELESAI | `wave11a §12` 16 |
| 79 | CSP + netralisasi HTML | SELESAI | `wave11a-csp` 187 (naik 2 tiap halaman baru); header CSP di nginx = kode |
| 80 | Pagar konteks total | SELESAI | `wave11a §13` 14 |

Yang **belum** beres di 11A dan perlu perhatian Bapak:
- **Deploy v0.21.0** SUDAH dijalankan bersama rilis v0.23.0 (26 Sep 2026): skema naik ke 19 lewat
  gerbang migrasi di salinan cadangan, dan `SECRETS_KEY` sudah diisi di `.env` server. Sembilan kunci
  baru masuk lewat `env-sync.sh` saat deploy; tanpa `SECRETS_KEY` rute rahasia akan menjawab
  `503 SECRETS_KEY_MISSING` — sekarang tidak.
- **Butir 42 bagian DoD** ("perintah tulis berkas tidak menghasilkan artefak saat mode diskusi")
  belum bisa dibuktikan dengan mesin mock — butuh mesin AI nyata.
- **Butir 48**: pagar anti-bentrok-tulis hanya berlaku di dalam satu proses; dua pekerja terpisah
  tidak saling melihat.
- **Butir 79**: gaya inline di dalam dokumen Word yang ditampilkan lewat `srcdoc` bisa hilang karena
  mewarisi CSP halaman induk (isi tetap terbaca, skrip tetap diblokir).
- **Butir 40 (dari daftar lama)**: direktori uji di `/tmp` masih menumpuk (~174 direktori, ~800 MB),
  menunggu izin hapus.

### 6.2 Wave 11B (v0.22.0) — SELESAI DI KODE, SUDAH LIVE (26 Sep 2026)

Butir 58–67, 83, **plus butir 72** (ditarik dari 11C karena 83 memprasyaratkannya). Skema **19 → 20**.
Gerbang: `npm run verify` **48/48 suite hijau** keluar 0; empat suite 11B (81/92/111/103 lulus, 0 gagal,
**0 dilewati**) = **387 pemeriksaan API**; tsc 0 galat; gerbang migrasi OK; gerbang env 70/0; rincian di
`docs/STATUS.md` bagian "Wave 11B (v0.22.0)".

Yang perlu diketahui operator (bukan bug, tapi bisa mengejutkan):
- Butir 58 (dewan juri): pemotongan kuota hanya berlaku **antar-gelombang** juri (paralel maksimum 2).
- Butir 61 (benchmark): berkas `apps/api/benchmark/questions.json` **wajib ikut ke image**; kedua
  Dockerfile sudah diberi baris `COPY`. Tanpa itu produksi gagal `BENCHMARK_QUESTIONS_MISSING`.
- Butir 59 (uji bayangan): bawaan **mati**; admin boleh menyalakan lewat API; pencatatan gagal-aman.
- Butir 63 (lanjutkan run): otomatis maksimum 1, manual maksimum 3, tanpa rantai lanjutan, dan
  percakapan mode diskusi tidak pernah dilanjutkan otomatis.
- Antarmuka 11B (halaman Jadwal, Benchmark, Timeline, Pemakaian/Aktivitas saya, laporan galat admin,
  kartu mode bayangan & saldo token, tab Pelajaran, tombol dewan juri, tombol Lanjutkan, ekspor/impor
  persona) dikerjakan agen dashboard; angka uji peramban diisi setelah gerbang peramban selesai.
- **Menunggu keputusan Bapak sebelum rilis:** menyetel `APP_VERSION=0.23.0` di `.env` server saat
  deploy, bersama `SECRETS_KEY` dan `CSP_ENABLED` (dua kunci terakhir wajib ada supaya fitur 11A hidup).

### 6.3 Wave 11C (v0.23.0) — SELESAI DI KODE, SUDAH LIVE (13 butir, skema 20 → 21, port 7320–7349)

68 Notion · 69 Bot Telegram · 70 Bot WhatsApp (Twilio) · 71 Katalog plugin & konektor ·
72 Jadwal prompt (**sudah dikerjakan di Wave 11B**) · 73 Grup chat multi-agen · 74 Nominal unik 3 digit ·
75 Kupon TRIAL · 76 Avatar agen & foto profil · 78 Periksa versi mesin (tahap 1 saja) ·
81 Identitas & penagihan kanal bot · 82 Isolasi proses konektor · 77 ⏸ TERTAHAN (login Google).

Keadaan 26 Sep 2026 — **kode selesai, gerbang hijau, belum ada deploy/restart/commit.** Skema
**20 → 21** (`user_integrations`, `bot_channels`, `bot_identities`, `connectors`,
`conversation_participants`, `conversations.kind`, `orders.unique_amount_idr`, `coupons.trial` +
`coupons.trial_plan_code`, `users.avatar_path`), `config.ts` / `dataexport.ts` / `jobs.ts` diperbarui,
kunci baru masuk `.env.austria.example` **dan** `deploy/env.keys.txt` (gerbang env 70/0).

Gerbang: tipe 0 galat (dua tsconfig) · **459 pemeriksaan API Wave 11C, 0 gagal, 0 dilewati**
(9 suite, dijalankan side lead) · uji sambung 23/23 (22 rute menjawab 401/403, rute palsu 404) ·
`npm run verify` **57/57 suite hijau + `ALL_SUITES_PASSED`** · antarmuka dashboard Wave 11C (halaman Notion, Kanal bot, Konektor, nominal unik di Tagihan, foto profil/avatar, kartu versi mesin) build 0 galat + uji peramban **222/222 lulus, 0 gagal, 1 dilewati jujur** (naik 53 pemeriksaan dari 169; 3 jalan agen + 2 jalan lead, semua 222/222).
Rincian per butir + 21 catatan jujur ada di `docs/STATUS.md` § "Wave 11C (v0.23.0)".

Operator notes (penting sebelum rilis):
- Paket rilis Wave 11 **wajib** menyetel `APP_VERSION=0.23.0` di `.env` peladen (sekarang masih `0.19.0`).
- Butir 76: JPEG/WebP ditolak `503 IMAGE_PROCESSOR_UNAVAILABLE` sampai pemroses gambar dipasang.
- Butir 78 **tahap 2** (perbarui + rollback mesin) tidak dibuat: menunggu keputusan **K5**.
- Butir 74: pesanan yang sudah punya kode nominal dijawab 200 (bahkan setelah dibayar) supaya
  rekonsiliasi bank tetap jalan; kalau Bapak ingin 409 untuk pesanan non-pending, itu satu baris.
- Butir 73: giliran percakapan grup **SUDAH DIKUNCI** (26 Sep 2026). Penanda "satu giliran berjalan" diperiksa dan diklaim di dalam SATU transaksi tulis, jadi dua giliran bersamaan tidak mungkin membuat dua run; yang kalah dijawab `409 GROUP_TURN_BUSY` beserta `runId` pemenangnya (bukti dua proses: `wave11c-grup` 73 cek). Batas jujurnya: giliran yang macet akan dilepas oleh `run.reap` setelah ±45 menit.
- Butir 74 **cabang `409 GATEWAY_EXACT_AMOUNT` belum bisa dicapai lewat API publik** (temuan agen UI, sudah saya periksa sendiri di kode): rute `POST /api/v1/billing/orders` hanya menerima `planCode`, `months`, `couponCode`, `note` — tidak ada `method` — sehingga `billing.ts` selalu memakai `method` = `free` (total 0) atau `manual`. Jadi penolakan nominal unik untuk pesanan gateway benar sebagai pengaman, tetapi belum ada alur pesanan gateway yang bisa memicunya. UI menuliskan kedua kode apa adanya dan uji memverifikasi `409 ORDER_NOT_PENDING` yang nyata. Tidak saya ubah karena keputusan butir 74 adalah "jangan diubah".

Yang **tidak** bisa diuji penuh tanpa bahan dari Bapak (kode tetap dibuat, uji memakai hulu tiruan):
- Butir 68: **SUDAH diuji nyata 26 Sep 2026** dengan token Bapak — lihat §6.5. Yang belum: integrasi Notion khusus produksi (Bapak akan membuatkannya).
- Butir 69/81: **jalur KELUAR Telegram sudah diuji nyata 26 Sep 2026** (§6.5); yang belum diuji dengan layanan asli adalah pembaruan MASUK (`setWebhook` belum dipanggil) dan seluruh jalur Twilio/WhatsApp (butir 70) — kredensial Twilio sungguhan belum ada.
- Butir 71: badan kiriman gaya Slack/Discord **sudah terbukti diterima penangkap webhook nyata** (§6.5), tetapi belum diterima Slack/Discord asli karena URL Incoming Webhook sungguhan belum ada.
- Butir 78: mesin sungguhan tidak dijalankan; versi dibaca dari biner tiruan (`prime-agent --version`
  mencetak `0.9.5` ke stderr — itu fakta dari luar suite, bukan dari uji).

### 6.4 Keputusan Bapak 26 Sep 2026 (rencana rilis Wave 11) — dicatat apa adanya

1. **Rilis v0.23.0 disetujui** dengan urutan: commit → tag → `.env` peladen diisi `APP_VERSION=0.23.0`,
   `SECRETS_KEY` (dibuat dengan `openssl rand -base64 32`, disimpan), `CSP_ENABLED=true` → paket rilis →
   deploy Austria → smoke. Alasan CSP aman dinyalakan: sudah diukur di peramban asli (0 galat); **tidak ada
   mode report-only**, jadi bila halaman rusak satu-satunya jalan balik adalah menyetel `CSP_ENABLED=false`.
   Recon 26 Sep 2026: `.env` peladen (83 baris) belum punya `SECRETS_KEY` maupun `CSP_ENABLED`;
   `APP_VERSION` masih `0.20.2`; `MOCK_ENGINE=false` (mesin sungguhan, provider deepseek).
2. **`sharp` TIDAK dipasang.** Butir 76 diselesaikan di sisi peramban: berkas JPEG/WebP diubah ke PNG
   lewat `<canvas>` (`canvas.toBlob(..., "image/png")`, dipotong 512×512) SEBELUM diunggah. Unggahan
   mentah JPEG/WebP langsung ke API tetap ditolak `503 IMAGE_PROCESSOR_UNAVAILABLE` — itu disengaja.
   `sharp` hanya dipertimbangkan bila nanti ada kebutuhan unggah langsung lewat API.
3. **Butir 78 tahap 2 (perbarui + rollback) TETAP DITANGGUHKAN.** Syarat membangunnya: v0.23.0 sudah stabil
   DAN ada satu percobaan rollback paket yang terbukti.
4. **Butir 74 tidak diubah** (keputusan Bapak: kode sudah benar). Catatan jujur hasil pemeriksaan saya:
   yang idempoten lebih dulu adalah kasus "sudah punya kode" — pesanan **pending** yang sudah punya kode
   dijawab 200 (klik ganda tidak mengubah nominal), dan pesanan **non-pending TANPA kode** dijawab
   409 `ORDER_NOT_PENDING`. Kasus "non-pending DAN sudah punya kode" saat ini juga dijawab 200 (kode dibaca
   lebih dulu), bukan 409 — itu yang menjaga rekonsiliasi bank. Bila Bapak mau varian ketat (409 untuk
   semua non-pending), perubahannya satu baris di `wave11c/bayar.ts`.
5. **Kunci giliran grup ditambahkan** (butir 73): satu percakapan grup hanya boleh punya satu giliran
   berjalan; giliran kedua dijawab 409 `GROUP_TURN_BUSY`. Ini pengaman biaya, bukan fitur.
6. **Kredensial nyata**: Bapak akan memberi token bot Telegram + satu webhook Slack/Discord; token Notion
   sudah ada di penyimpanan Bapak. Uji jalur asli menunggu nilai itu (saya tidak menebak rahasia).
7. **Bersih-bersih dijalankan 26 Sep 2026**: 498 folder `/tmp/coder-*` dihapus (`/tmp` 2,1 GB → 256 MB;
   disk 86% → 84%, sisa 17 GB) dan proses sisa `vite --port 5199` (pid 6156/6170/6171 + esbuild 6179)
   dihentikan — keempatnya sekarang zombie, tidak memakai CPU/RAM.

### 6.5 Uji keluar SUNGGUHAN 26 Sep 2026 (Telegram, Notion, konektor) — hasil apa adanya

Kredensial uji dari Bapak dipakai **hanya** untuk pengujian: berkasnya di luar repo (izin 600),
**sudah dihapus (shred)** sesudah uji, tidak satu pun nilainya ditulis di dokumen ini atau di berkas repo.
Skrip uji juga di luar repo (`/workspace/outputs/`), jadi `npm run verify` tidak pernah menyentuhnya.

1. **Telegram (butir 69/81) — DITERIMA API ASLI.** Dari jalur kode kita sendiri: kanal bot dibuat lewat
   rute admin (rahasia webhook tersegel) → penautan chat lewat kode sekali pakai → 200 pemilik benar →
   webhook masuk (pembaruan disimulasikan) 200 `diterima:true` + run nyata → pekerja `bot.reply` status
   `done` → `POST https://api.telegram.org/bot<token>/sendMessage` **200 `ok:true`, `message_id=4`**, pesan
   benar-benar terbuat di DM Bapak. `getMe`/`getChat` juga 200. 11/11 periksa lulus, 0 gagal.
2. **Notion (butir 68) — DITERIMA API ASLI.** `PUT /api/v1/integrations/notion` 200 dengan `users/me` nyata
   (nama workspace terbaca) · `POST /api/v1/integrations/notion/pages` membuat halaman di bawah halaman induk
   yang Notion wajibkan · halaman itu **diarsipkan** dan `GET /v1/pages/<id>` membalas `archived=true`
   (bukti halamannya nyata, sekaligus bukti tidak ada sampah ditinggal di Notion Bapak) · `DELETE` integrasi 200 ·
   token tersegel `enc:v1:` dan tidak pernah kembali lewat API · token asli tidak ditemukan di `coder.db`
   maupun `coder.db-wal` (basis data memakai WAL — memeriksa `.db` saja tidak cukup, pelajaran nyata).
3. **Konektor Slack/Discord (butir 71/82) — SAMPAI ke penangkap webhook nyata.** `POST /connectors/<id>/test`
   mengirim gaya Slack `{text,username}` dan gaya Discord `{content,username}`; keduanya `hulu=200` di sisi kita
   dan **tercatat di penangkap** dengan user-agent `node` + penanda uji unik. Baris konektor uji dibersihkan,
   katalog kembali seperti semula.

**Batas jujur yang belum terbukti:**
- Slack/Discord **asli** belum mengesahkan payload (baru penangkap yang menerima) — butuh URL Incoming Webhook asli.
- Pembaruan MASUK Telegram belum diuji dengan layanan asli: `setWebhook` sengaja tidak dipanggil karena alamat
  kita masih `127.0.0.1` dan `BOT_WEBHOOK_BASE_URL` kosong; memanggilnya akan mengarahkan webhook bot Bapak ke
  alamat tidak sah. Perlu keputusan Bapak (alamat publik) sebelum diuji.
- Twilio/WhatsApp (butir 70) tidak diuji ke layanan asli: belum ada kredensial.
- Batas laju (429) dan cabang cadangan "teks polos" Telegram belum terpicu di API asli.
- Eksekusi mesin tetap mesin tiruan; yang nyata pada uji ini adalah jalur keluar, kanal, penautan, dan webhook.
- Batas pribadi Bapak dihormati: uji Telegram dibatasi 2 pesan (terpakai 1).

### 6.6 Kerapuhan gerbang rilis: port uji yang diblokir `fetch` — SUDAH DITUTUP (26 Sep 2026)

Ini bukan cacat produk, tapi cacat **harness uji** yang bisa membuat gerbang rilis merah tanpa sebab produk:

1. **Akar masalah (TERBUKTI, bukan dugaan).** `fetch()` Node menolak daftar "bad port" spesifikasi Fetch. Bila nomor
   acak yang dipilih suite kebetulan ada di daftar itu, setiap `fetch` gagal seketika
   (`TypeError: fetch failed`, cause `bad port`), sementara sambungan TCP biasa dan `node:http` ke port yang sama
   menjawab normal — jadi suite melapor "server tidak siap" padahal peladen uji hidup. Bukti jejak:
   `tcp=tersambung httpPolos=HTTP 200 ragamGalatFetch=160x ... bad port`. Ini yang menjatuhkan gerbang putaran 5
   (`wave6.e2e.ts`, nomor 6566) dan sudah direproduksi 2 kali dari 24 putaran mandiri.
2. **Daftar diukur, bukan dihafal**: pada rentang 3300–7599 nomor terblokir = 3659, 4045, 4190, 5060, 5061, 6000,
   6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697.
3. **Perbaikan**: berkas baru `apps/api/test/port-aman.ts` (`PORT_TERBLOKIR_FETCH` + `pilihPortUji()`), dipakai
   `wave6.e2e.ts`, `csrf-limits.e2e.ts`, dan `outbox-mail.e2e.ts` (satu-satunya tiga suite yang rentang portnya kena).
   Gerbang baru `port-uji-fetch-aman.e2e.ts` **20/20 hijau** memindai seluruh berkas uji agar tidak ada suite yang
   kembali memakai rentang mentah berisi nomor terblokir.
4. **Diagnosis dibuat permanen**: `wave11a.e2e.ts` dan `wave6.e2e.ts` mencetak jejak saat batas waktu habis, dan
   `run-all.cjs` menyimpan log UTUH setiap suite merah. Tidak ada pemeriksaan yang dilemahkan.
5. **Sisa yang jujur belum terbukti**: gerbang putaran 2 merah di `wave11a.e2e.ts` (169/176, 97,8 dtk). Dugaan
   terkuat — suite berat lain (`paket_integritas`) berjalan di dalam jendela putaran itu, melanggar aturan "jangan
   menjalankan dua gerbang node berat berbarengan" — belum direproduksi, jadi tidak dinyatakan sebagai sebab.
   Aturan kerja yang saya pakai sekarang: dua putaran gerbang penuh berturut-turut harus hijau, tanpa beban paralel.

### 6.7 Dua temuan nginx di produksi v0.23.0 — SUDAH DIPERBAIKI DAN DIVERIFIKASI (26 Sep 2026)

Rilis v0.23.0 sudah LIVE dan sehat (lihat `docs/STATUS.md` bagian "Rilis v0.23.0 — LIVE DI
PRODUKSI"). Dua hal di bawah ditemukan saat memeriksa produksi sesudah deploy. Keduanya berasal dari
berkas nginx di peladen, bukan dari kode aplikasi, dan keduanya butuh satu perubahan berkas itu +
`reload` halus. **Belum ada yang diubah di peladen.**

**Temuan 1 — Google Fonts diblokir di produksi (terukur, akibat kosmetik).**
Bagaimana terukur: peramban Chromium sungguhan memuat halaman masuk produksi; konsol mencatat
`Refused to load the stylesheet 'https://fonts.googleapis.com/...' because it violates the following
Content Security Policy directive: "style-src 'self' 'unsafe-inline'"`. Dashboard tetap hidup dan
gayanya terpasang (`border-radius=12px`), hanya font khusus jatuh ke font sistem.
Sebab: nginx peladen memakai nilai CSP lama (243 karakter) tanpa `fonts.googleapis.com` /
`fonts.gstatic.com`; aplikasi memakai nilai baru (309 karakter) yang memuat keduanya. Peramban
menegakkan irisan kedua kebijakan, jadi irisan itu kehilangan kedua asal font.
Sejak kapan: kebijakan nginx itu dipasang 13 Sep 2026. Jadi font **sudah** diblokir sebelum rilis ini;
rilis ini hanya menambahkan nilai yang benar di repo (aplikasi + salinan rujukan nginx) tanpa
menyentuh berkas di peladen. Yang belum pernah ada sebelumnya: pengukuran di peramban produksi.
Perbaikan yang disiapkan: `deploy/nginx-sync-csp.sh --apply` mengganti HANYA baris CSP di
`/etc/nginx/sites-available/coder.sam.university.conf` dengan nilai dari salinan rujukan repo,
mencadangkan berkas lebih dulu, lalu `nginx -t`; bila `nginx -t` gagal, berkas dipulihkan otomatis
dan `reload` tidak dijalankan.

**Temuan 2 — CSP nginx ikut menempel pada berkas artefak mentah (perkiraan, belum diuji ujung-ke-ujung).**
Bukti yang sudah ada: `add_header` CSP di peladen dipasang di tingkat `server`, dan `curl` tanpa login
ke `/api/v1/artifacts/<id>/raw` memang menerima header CSP dari nginx (dan satu lagi dari aplikasi).
Kekhawatirannya: aplikasi sengaja **menghapus** CSP untuk jawaban PDF, karena penampil PDF bawaan
Chrome kosong bila `object-src 'none'` berlaku (catatan itu ada di `apps/api/src/wave11a/csp.ts`).
nginx menambahkan CSP-nya lagi, jadi pratinjau PDF di produksi bisa kosong.
Yang belum dibuktikan: apakah pratinjau PDF benar-benar kosong di produksi. Itu butuh sesi login nyata
plus satu berkas PDF di produksi. **Belum diuji, jadi belum boleh disebut bug** — hanya perkiraan
berdasar dua bukti di atas.
Perbaikan yang disiapkan: blok `location ~ ^/api/v1/artifacts/[^/]+/(raw|download)$` tanpa CSP (header
keamanan lain dikembalikan manual, karena nginx menggugurkan seluruh `add_header` warisan begitu
sebuah location punya `add_header` sendiri).

**Hasil sesudah izin Bapak (26 Sep 2026).** `deploy/nginx-sync-csp.sh --apply` dijalankan:
`BARIS_CSP_DIGANTI=1`, `BLOK_ARTEFAK_DITAMBAH=true`, `NGINX_T_OK=true`, `NGINX_RELOAD_SELESAI=true`;
cadangan `/etc/nginx/sites-available/coder.sam.university.conf.bak.20260926222321`.
Bukti temuan 1 tertutup: CSP aplikasi dan CSP lewat nginx kini sama persis (309 karakter), dan di
peramban sungguhan berkas gaya Google Fonts tidak lagi ditolak — `document.fonts.check` true untuk
"DM Sans" dan "Space Grotesk"; skrip pemeriksa produksi naik dari 4 lulus / 2 gagal menjadi **6/6**.
Bukti temuan 2 tertutup sebagian: jalur `/api/v1/artifacts/:id/raw` lewat nginx sekarang membawa tepat
satu header CSP (milik aplikasi), jadi nginx tidak lagi menempelkan `object-src 'none'` pada jawaban
PDF. **Yang masih belum diuji:** pratinjau PDF di UI dengan sesi login nyata + berkas PDF. Jadi
temuan 2 masih berupa perbaikan yang masuk akal, belum hasil uji ujung-ke-ujung.
Catatan tambahan (jujur, di luar cakupan PRD): blok `location /apk/` milik aplikasi Personal Life OS
punya `add_header` sendiri, sehingga header keamanan warisan tidak berlaku di jalur itu. Tidak diubah
pada rilis ini.

### 6.8 Audit menyeluruh Wave 11 + perbaikan + rebuild (26 Sep 2026) — perintah Bapak

Bapak meminta: "cek dulu pekerjaan mana saja yang belum selesai dan belum di uji, tuntaskan semuanya,
lalu rebuild kalau sudah diperbaiki, baru push." Bagian ini mencatat cara pemeriksaannya, temuan
beserta perbaikannya, dan — yang penting — apa yang MASIH belum tuntas.

**Cara audit (bukan membaca laporan, tetapi membaca kode).** Tiga agen audit memeriksa tiga wilayah
dan menulis temuan dengan `berkas:baris` + kutipan asli:
`/workspace/outputs/audit/audit_11ab.md` (Wave 11A/11B), `/workspace/outputs/audit/audit_ui.md`
(antarmuka + `e2e/ui.e2e.mjs`), `/workspace/outputs/audit/audit_11c.md` (Wave 11C).
Setiap temuan diuji ulang oleh lead sebelum diperbaiki; temuan yang tidak terbukti TIDAK diperbaiki
(lihat bagian "temuan yang gugur" di bawah).

**Temuan berat dan perbaikannya.**

| Butir | Temuan audit | Perbaikan | Bukti uji |
|---|---|---|---|
| 42 | Mode diskusi hanya menempel di prompt; perintah "tulis berkas" tetap bisa menghasilkan artefak lewat API | Penjagaan di pintu artefak (`server.ts`): run wajib milik proyek itu (`400 RUN_NOT_IN_PROJECT`), percakapan mode diskusi → `409 DISKUSI_MODE_NO_EXECUTE` + audit `artifact.blocked_diskusi` | `wave11a.e2e.ts` cek 1p–1v; `w11a_42_run.log` 200 lulus |
| 45/46 | Tiga jalan pintas lolos dari penyaring prompt: jadwal (`schedules.ts`), Playground, dan jalur lanjutkan run | `promptBlockFor()` di jadwal (audit `schedule.blocked`), guardrail Playground (`400 GUARDRAIL_BLOCKED`), jalur lanjutkan (`409 RESUME_PROMPT_BLOCKED` / `RESUME_GUARDRAIL_BLOCKED`) | `w11b_63_run2.log` 109 lulus; `w11a_46_run3.log`; `w11a_57_run2.log` |
| 56 | Perkiraan biaya memakai harga luar-jam-puncak untuk model vendor; uji membandingkan rute dengan fungsi yang sama | `estimate.ts` memakai `quoteCosts()` (tarif puncak 2x ikut), `tarifPuncak` dilaporkan; 8 cek baru (11j–11q) membandingkan angka NYATA | `fix-perkiraan-biaya`: puncak 465 = 465 (sebelumnya 232) |
| 61 | Biaya benchmark ±14x terlalu besar (5690 vs 404) karena harga dihitung per kelompok | `catatPemakaian()` mengembalikan `id` baris; biaya dihitung per baris | `wave11b-council.e2e.ts` 94 lulus; mutasi 3 gagal |
| 63 | `attemptAutoResumes` tidak punya pemanggil di produksi (kebijakan "otomatis maks 1" tidak pernah jalan) | Pekerja `resume.scan` (`server.ts`) sekarang memanggil `attemptAutoResumes` dan melaporkan `{marked, diperiksa, dilanjutkan, dilewati}` | `wave11b.e2e.ts` §12ag/12ah; 109 lulus |
| 62 | `run_events.type='tool'` tidak pernah ditulis (jalur produksi tidak punya cabangnya) | `prime-rpc-engine.ts` menulis `tool_execution_start`/`tool_execution_end` (ringkas ≤600 karakter) | suite baru `wave11b-timeline-alat.e2e.ts` 19/19; mutasi 9 lulus/10 gagal |
| 71 | Daftar putih alat MCP tidak punya penulis (UI/API) | `connector-store.setMcpAllowedTools()` + rute admin + panel di `Connectors.tsx` | `wave11c-konektor.e2e.ts` 53/53; `tsc -b` 0 galat |
| 69 | Uji kirim kanal bot: catatan UI menyebut rute yang tidak ada | Rute `POST /admin/bot-channels/:id/test` + tombol uji di UI | suite bot 110 lulus |
| 57 | (a) Kode galat mesin sungguhan (`ENGINE_EXITED`, `RPC_FRAME_TOO_LARGE`) tidak diklasifikasi, jadi mesin mati tidak pindah model; (b) galat permanen sesudah satu perpindahan dilaporkan sebagai `ENGINE_UNAVAILABLE`; (c) cek 12l lulus karena alasan yang salah (pesan uji memotong kode galat) | `fallback.ts`: daftar kode mesin sementara/permanen (permanen menang); `server.ts` meneruskan kode galat mesin; galat asli dilaporkan bila percobaan terakhir permanen | `wave11a.e2e.ts` 208 lulus (cek 12h0, 12l, 12l2–12l6, 12u baru) |
| **baru saat butir 57** | Katalog model dari CLI mesin bisa menjawab TIDAK LENGKAP (penyedia lambat). Jawaban pendek dulu menimpa daftar lama, sehingga model SAH ditolak `400 UNKNOWN_MODEL`. Kejadian nyata: `/workspace/outputs/w11a_57_run.log` (12h, 12n) gagal saat gerbang peramban berjalan bersamaan, lalu hijau tanpa perubahan kode | `server.ts`: ingatan katalog hanya BERTAMBAH (jawaban pendek tidak menghapus model yang sudah dikenal), pencocokan juga lewat nama dasar (tanpa awalan penyedia), dan `GET /api/v1/models?refresh=1` menyegarkan ingatan itu | suite baru `wave11a-katalog.e2e.ts` 10/10 (`WAVE11A_KATALOG_PASSED`); mutasi ke perilaku lama → 4 gagal, termasuk `400 UNKNOWN_MODEL` yang sama |
| 66 | Penyaring rahasia tidak menyunting kunci platform `ck_<40 heks>` | `wave11b/errors.ts` menambah pola itu | uji `wave11b-metrik.e2e.ts` 111 lulus |
| uji palsu | Tujuh berkas uji memuat cek yang selalu hijau (`check(..., true)`, `skip=0` literal, argumen `checkApi` bergeser) | Semua dihapus/diperbaiki; tidak ada lagi cek yang selalu hijau | `rg 'check\([^,]*,\s*true\)'` kosong; `fix_ui_uji_run1.log` 223 lulus/0 gagal/1 lewat |
| `ui.e2e.mjs` | Rute tak ada dianggap bukti; `5xx` bisa bersembunyi; satu cek tautologi (`run-fallback-marker` ATAU `run-fallback-none`); 7 `checkApi` salah argumen | `SKIP-RUTE` + aturan 5xx deklaratif + cek tautologi diganti + argumen diperbaiki | `fix_ui_uji_run1.log` 223/0/1 dari 224 titik |

**Temuan audit yang GUGUR (tidak diperbaiki karena tidak terbukti).**
- "Penampil PDF kosong di produksi" — dibuktikan sebagai batasan alat uji: Chromium bawaan Playwright
  tidak punya penampil PDF. Kontrol tanpa CSP juga kosong, jadi bukan cacat produk.
- "Cek 5xx harus menutup semua jalur" — sebagian jalur tidak pernah memicu 5xx di suite; empat jalur
  yang tidak pernah terpicu DIBUANG dari daftar putih (bukan ditambah), supaya daftar tidak jadi hiasan.
- Usulan menyatukan seluruh penyaring prompt jadi satu pintu: ditolak karena setiap jalur punya bentuk
  jawaban berbeda (jadwal `{dijalankan:false}`, lanjutkan 409, Playground 400). Yang disatukan hanya
  fungsinya, bukan bentuk jawabannya.

**Yang MASIH belum tuntas (jujur).**
1. ~~Deploy ulang dashboard ke produksi belum dijalankan.~~ **SUDAH DIJALANKAN 27 Sep 2026** atas izin Bapak:
   `deploy-austria.sh 0.24.0` exit 0, wadah produksi kini `coder-platform-app:0.24.0 (healthy)`, uji asap
   produksi 202 lulus/0 gagal, dan verifikasi peramban produksi 15 lulus/0 gagal (lihat §6.9).
2. **Push ke GitHub** menunggu token dari Bapak. Cadangan sementara: bundel git di `/workspace/outputs/`.
3. **Pratinjau PDF ujung-ke-ujung** masih belum diuji karena butuh Chrome desktop sungguhan.
4. **Kredensial uji live** (akun uji produksi #2) masih hidup. Rangkaian uji produksi v0.24.0 sudah selesai
   seluruhnya, jadi akun ini siap ditutup — menunggu keputusan Bapak.

### 6.9 Verifikasi produksi v0.24.0 di peramban + tiga catatan temuan (27 Sep 2026)

**Hasil: LULUS.** Skrip `/workspace/outputs/prod_ui_v0240.mjs`, log `/workspace/outputs/prod_ui_v0240.log`,
tangkapan layar `/workspace/outputs/prod_v0240_pemakaian.png` — **15 lulus / 0 gagal, `PROD_UI_V0240_OK`, exit 0**.
Yang dibuktikan pada domain sungguhan `coder.sam.university` (akun uji yang diizinkan Bapak):
halaman utama 200; masuk lewat antarmuka sungguhan (42 tautan menu muncul); proyek aktif termuat;
halaman **Pemakaian** menampilkan kartu **butir 80** beserta angkanya; halaman memanggil
`GET /api/v1/context-budget/report` (200) dan angkanya cocok dengan jawaban server; kalimat jujur
"Tidak ada sisipan yang dipotong pada pemeriksaan terakhir." tampil apa adanya; halaman **Status platform** melaporkan
`Versi platform: 0.24.0`; 0 galat konsol, 0 galat JavaScript, 0 permintaan jaringan gagal, 0 jawaban API 5xx
dari 32 panggilan. Nilai kartu saat diperiksa: `12.000` pagar aktif, `0` total sebelum dipotong,
`0` terkirim ke mesin (jadi "tidak melewati pagar" memang benar untuk akun uji).

**Catatan 1 — batasan alat uji (BUKAN cacat produk): CSP produksi menolak `page.waitForFunction`.**
CSP produksi `script-src 'self'` tanpa `'unsafe-eval'`, sedangkan `page.waitForFunction` Playwright
mengevaluasi string JavaScript di halaman. Akibatnya pemeriksaan peramban harus menunggu lewat
locator/kueri dari sisi Node (`count()`, `innerText()`, `inputValue()`), bukan lewat fungsi di halaman.
Ini alasan teknis mengapa berkas uji memakai penantian berulang dengan batas 900 ms, bukan penantian pintar.

**Catatan 2 — TEMUAN NYATA yang BELUM diperbaiki (di luar butir PRD 42–83, sudah ada sebelum v0.24.0).**
Sesudah orang **masuk lewat form di dalam halaman** (bukan membuka situs dengan sesi yang sudah ada),
dasbor **tidak memuat daftar workspace, proyek, dan percakapan** sampai halaman dimuat ulang.
Gejalanya: pemilih "Proyek" menulis `(belum ada proyek)`, penanda koneksi menulis `Mode lokal`, halaman
Pemakaian menulis "Halaman ini butuh proyek aktif…", padahal server sehat.
Bukti:
- Kode: `coder-dashboard/src/App.tsx:113` memuat daftar itu hanya di dalam satu efek saat rakitan
  pertama (`api.me().then(... loadSessions() ...)`), sedangkan `submitAuth` (`App.tsx:322–331`) sesudah
  masuk hanya memanggil `api.me()` untuk menyegarkan penanda admin — **`loadSessions()` tidak dipanggil**.
- Pemantauan permintaan di produksi: sesudah masuk dari dalam halaman, **tidak ada** panggilan
  `GET /api/v1/workspaces` sama sekali (hanya `/onboarding`, `/personas`, `/models`, `/agents/settings`,
  `/billing/quota-alert`). Setelah `page.reload()`, seluruh daftar langsung termuat normal.
- Server sehat bersamaan: `GET /api/v1/workspaces` → 200 berisi 1 workspace; `GET /api/v1/workspaces/<id>/projects` → 200.
- **Bukan regresi v0.24.0**: kode yang sama ada di tag `v0.23.0`; commit `990799a` hanya mengubah 1 baris
  di `App.tsx`.
Usul perbaikan (1 baris, perlu bangun ulang dasbor + deploy ulang): sesudah `setUser(d.user)` di
`submitAuth`, panggil `void loadSessions().catch(() => setOnline(false));`.
Dampak: pengguna baru selalu melihat dasbor setengah kosong sampai menekan muat ulang. Gerbang uji
antarmuka saat ini **menyiasati** keadaan itu (`e2e/ui.e2e.mjs` memuat ulang halaman sesudah masuk),
sehingga gerbang tidak pernah menangkapnya. Status: **menunggu keputusan Bapak** (perbaiki sekarang
dengan rilis v0.24.1, atau tunda ke gelombang berikutnya).

**Catatan 3 — sisa data uji di akun uji produksi.** `production-smoke.mjs` memakai proyek pertama akun uji
lalu **mengganti namanya** menjadi `Smoke Project <stempel waktu>` (baris 238) dan tidak mengembalikan
nama lama. Projek akun uji sekarang bernama `Smoke Project 1790499853279`. Ini hanya menyentuh akun uji,
tidak menyentuh data pengguna lain, tetapi tercatat supaya tidak mengagetkan Bapak.

### Cara memakai daftar ini
Bapak cukup menyebut NOMOR (mis. "bereskan 15, 17, 24"). Saya kerjakan satu per satu, dengan
bukti uji nyata, dan memperbarui status di berkas ini setelah tiap nomor selesai.
