# DAFTAR MASALAH & PEKERJAAN TERTUNDA — COBLAI Coder (coder.sam.university)

Dikumpulkan atas perintah Bapak: "SEMUA MASALAH DAN YANG BELUM BERES, DIKUMPULKAN,
NANTI TERAKHIR KITA BERESKAN SATU PER SATU."

Versi platform saat daftar ini diperbarui: **v0.20.1 (Wave 10 penuh + perbaikan dashboard butir 41)**. **LIVE di server Austria sejak 19 Sep 2026 12:38 UTC; smoke produksi 199 lulus, 0 gagal; uji UI peramban 33/33 lulus.** Rincian bukti: `docs/STATUS.md` bagian "Deploy & operasi produksi v0.20.1".
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
    di-push.
14. [BAPAK] Batasi `mynetworks` relay mailcow (temuan 14 Sep: relay menerima surat tanpa
    autentikasi dari jaringan lokal host).

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
20b. [TEKNIS — butuh izin Bapak] Temuan dari pemeriksaan butir 20 (belum ada yang diubah):
    (a) `certbot renew --dry-run` keluar dengan kode 1 karena 5 sertifikat proyek LAIN gagal
    (cover, inventory, kampus, rena, sam.university — DNS NXDOMAIN / tantangan 404). Sertifikat itu
    bukan milik platform ini, jadi kami tidak menyentuhnya; perlu diteruskan ke pemiliknya.
    (b) Di `/etc/nginx/sites-enabled/` ada symlink sisa `coder.sam.university.conf.bak_20260920_091515`
    yang menunjuk berkas yang SAMA, sehingga nginx mencatat "conflicting server name" dan memuat
    blok server itu dua kali. Belum berbahaya (isinya identik), tetapi sebaiknya dihapus.
    (c) Tidak ada hook pasca-pembaruan untuk memuat ulang nginx; sertifikat coder memakai installer
    nginx sehingga reload dijalankan certbot sendiri saat benar-benar memperbarui.
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

---

### Cara memakai daftar ini
Bapak cukup menyebut NOMOR (mis. "bereskan 15, 17, 24"). Saya kerjakan satu per satu, dengan
bukti uji nyata, dan memperbarui status di berkas ini setelah tiap nomor selesai.
