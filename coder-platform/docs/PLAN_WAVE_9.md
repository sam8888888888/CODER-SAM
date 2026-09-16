# PLAN WAVE 9 (v0.19.0) — butir 16 sampai 20

Dokumen ini mencatat rencana dan bukti Wave 9 atas lima butir yang Bapak putuskan pada 16 Sep 2026.
Semua angka di sini diambil dari hasil perintah yang benar-benar dijalankan, bukan perkiraan.

## Butir 16 — deploy tanpa berhenti layanan (blue-green)

Keputusan Bapak: `--force-recreate` diizinkan, dan zero-downtime boleh dicoba selama aman.

Yang diubah:

- `docker-compose.austria.yml`: satu anchor `x-app: &app` dipakai tiga layanan supaya citra dan
  volume tidak pernah berbeda: `coder-platform-app` (biru, 127.0.0.1:3402), `coder-platform-app-green`
  (hijau, 127.0.0.1:3403, profil `green`), `coder-platform-worker` (antrean, tanpa port).
- `deploy/deploy-austria.sh`: tiga gerbang berurutan (rehearsal migrasi, tukar hijau-biru, buat ulang
  wadah antrean). Fungsi baru `point_nginx <port>` dan `wait_ready <port> <detik>`.

Alur tukar:

1. bangun citra versi baru;
2. rehearsal migrasi atas cadangan produksi terbaru (butir 18);
3. jalankan hijau di 3403, tunggu `/ready` (maks 120 detik);
4. arahkan nginx ke 3403 (`sed` pada berkas asli hasil `readlink -f`, `nginx -t`, `systemctl reload`);
5. buat ulang biru, tunggu `/ready` 3402, arahkan nginx kembali ke 3402;
6. hentikan hijau, buat ulang wadah antrean, verifikasi citra dan `/ready`.

Catatan jujur:

- Selama beberapa detik di langkah 3–5 ada dua proses aplikasi memakai berkas SQLite yang sama
  (mode WAL, `busy_timeout` sudah disetel). Migrasi v19 bersifat menambah kolom/tabel, jadi proses
  versi lama tetap bisa membaca skema baru.
- Kalau pola `proxy_pass http://127.0.0.1:34xx` tidak ada di berkas nginx, skrip TIDAK menebak:
  ia mencetak `ZERO_DOWNTIME_SKIPPED` dan kembali ke cara lama (`up -d --force-recreate`).
- Kalau hijau tidak siap, skrip berhenti dengan `DEPLOY_BLOCKED` dan trafik tetap di biru 3402;
  tidak ada satu pun permintaan yang diarahkan ke proses yang belum siap.
- Volume baru `coder-platform-engine-sessions` dipasang ke `/app/engine-sessions`
  (`ENGINE_ROOT_DIR`). Sebelumnya sesi mesin ikut lapisan wadah sehingga hilang setiap deploy;
  sekarang bertahan dan bisa dipakai bersama biru, hijau, dan wadah antrean.

Verifikasi yang bisa diulang: `bash -n deploy/deploy-austria.sh` (lolos), dan bukti nyata pada
laporan deploy (`ZERO_DOWNTIME_START`, `READY 3403`, `NGINX_POINTED 3403`, `NGINX_POINTED 3402`,
`ZERO_DOWNTIME_DONE`, `DEPLOY_OK`).

## Butir 17 — antrean di proses sendiri

Keputusan Bapak: satu proses per wadah, tidak masalah, asal rapi dan mudah dirawat.

Yang diubah:

- `apps/api/src/config.ts`: `JOB_WORKER_IN_WEB` (bawaan true) dan `WORKER_ONLY` (bawaan false).
- `apps/api/src/worker.ts` (baru): menyetel `WORKER_ONLY=true` dan `JOB_WORKER_IN_WEB=true` SEBELUM
  mengimpor `server.js`, jadi hanya ada satu implementasi penangan pekerjaan, tetapi proses ini tidak
  membuka pelabuhan HTTP. Ia mencetak denyut tiap 30 detik; denyut itu sengaja TIDAK `unref` karena
  `startJobWorker()` meng-`unref` pengatur waktunya sendiri — tanpa denyut, proses keluar sendiri.
- `apps/api/src/server.ts`: `startBackgroundWork()` berhenti lebih awal bila antrean dimiliki proses
  lain, dan pendengar HTTP tidak dijalankan saat `WORKER_ONLY=true`.
- `docker-compose.austria.yml`: layanan `coder-platform-worker` menjalankan `node dist/api/worker.js`,
  tanpa port, healthcheck dimatikan (tidak ada HTTP) dan diganti pembacaan denyut dari log.

Bukti: `apps/api/test/worker-split.e2e.ts` menjalankan dua proses nyata (server dengan
`JOB_WORKER_IN_WEB=false` dan worker) lalu memeriksa siapa yang memiliki antrean.
Hasil: **17 dari 17 cek lulus, `ALL_WORKER_SPLIT_TESTS_PASSED`**.

## Butir 18 — alat periksa migrasi, boleh jalan tiap deploy

Keputusan Bapak: boleh dijalankan tiap deploy, tetapi harus benar.

Yang diubah:

- `apps/api/src/migration-rehearsal.ts` (baru, ikut terkompilasi ke `dist/api` sehingga ada di dalam
  citra): menyalin cadangan produksi ke folder sementara (`mkdtemp`), menjalankan seluruh rantai
  migrasi di atas salinan itu, lalu memeriksa versi skema, tabel/kolom yang wajib ada, jumlah baris
  yang tidak boleh berubah (24 tabel penting), `PRAGMA integrity_check`, kunci asing, dua sisipan
  percobaan (satu dibatalkan), dan idempotensi dengan membuka berkas yang sama di proses kedua.
  Keluaran akhir `MIGRATION_REHEARSAL_OK` atau `MIGRATION_REHEARSAL_FAILED <n>`.
- `apps/api/test/migration-check.ts` menjadi pembungkus tipis (dulu berisi logika sendiri).
- `apps/api/test/run-all.cjs` menjalankan gerbang ini PERTAMA, sebelum suite lain, dan gagal cepat.
- `deploy/deploy-austria.sh` menjalankan alat ini di wadah sekali pakai dengan citra BARU, hanya
  memasang volume cadangan (baca saja, `/app/backups`). Volume data produksi tidak dipasang sama
  sekali sehingga data hidup tidak bisa tersentuh. Gagal → `DEPLOY_ABORTED` sebelum apa pun diganti.

Bukti: dua mode lulus di mesin lokal (basis data segar dan salinan basis data), `INTEGRITY_CHECK ok`,
`FOREIGN_KEYS true`, `ROW_COUNTS_PRESERVED true`, `REOPEN_IDEMPOTENT true`, `MIGRATION_REHEARSAL_OK`.

## Butir 19 — harga AI: harga asli + faktor markup

Keputusan Bapak: kolom masukan harga asli per 1 juta token dan faktor markup, supaya harga bisa
dijual lagi.

Arti kolom (dibekukan):

- `cost_micros` = harga pokok dari penyedia (COGS). TIDAK pernah disentuh markup; laporan laba
  (`revenueSummary`) memakainya sebagai biaya.
- `sell_cost_micros` = `round(cost_micros x markup)` = jumlah yang ditagihkan ke pelanggan.

Yang diubah:

- `apps/api/src/pricing.ts` (baru): `pricingSettings`, `setPricingMarkup`, `priceView`, `quoteCosts`,
  `sellForBaseMicros`, `validatePrice`, `savePriceOverride`, `clearPriceOverride`, `overrideCount`,
  `usageByModel`, `pricingTable`, `reloadPriceCache`, `catalogPriceFor`.
- `apps/api/src/db.ts`: skema 16 → 17, tabel `model_price_overrides`, kolom `sell_cost_micros` pada
  `run_usage` dan `user_usage`. `SCHEMA_VERSION` kini diekspor (dipakai gerbang migrasi).
- `apps/api/src/server.ts`: rute `GET/PUT/DELETE /api/v1/admin/pricing[/settings|/models/:model]`,
  blok `aiPricing` pada status-hub, `billedMicros`/`billedUsd` pada daftar run dan pemakaian proyek,
  serta penghitungan ulang seluruh riwayat saat markup berubah (jumlah baris dilaporkan).
- `coder-dashboard/src/AdminPricing.tsx` (baru, 792 baris) + `App.tsx` + `nav.ts`
  (menu "Harga AI"). Tampilan: ringkasan, pengatur markup, pencarian model, saringan
  semua/dipakai/harga sendiri, dan editor harga per model dengan pesan galat Bahasa Indonesia.

Bukti: `apps/api/test/pricing.e2e.ts` → 130 lulus / 0 gagal / 0 lewat, termasuk bukti
`run_usage` nyata `cost_micros=358 sell_cost_micros=716` (markup 2) dan `1074` (markup 3) sementara
`cost_micros` tidak berubah. `render-check-wave9.tsx` →
`ALL_WAVE9_PAGES_RENDERED` (halaman admin dan pesan tanpa akses).

Temuan yang diperbaiki: `catalog` pada `GET /admin/pricing/models/:model` sempat berisi harga
override; sekarang memakai `catalogPriceFor(model)` (harga daftar resmi).

## Butir 20 — periksa dan uji pengatur waktu TLS

Hasil pemeriksaan di server Austria:

- `systemctl is-active certbot.timer` → `active`; `certbot.timer` dijadwalkan dua kali sehari.
- Sertifikat `coder.sam.university` masih berlaku ±85 hari.
- `certbot renew --dry-run` → `Congratulations, all simulated renewals succeeded`.

Tidak ada perubahan konfigurasi: pengatur waktu sudah bekerja. Bila nanti gagal, alasan paling umum
adalah tantangan HTTP-01 tertutup oleh perubahan nginx; berkas nginx untuk situs ini hanya diubah
`sed` pada baris `proxy_pass` sehingga blok `.well-known/acme-challenge` tidak tersentuh.

## Bug nyata yang ditemukan dan diperbaiki saat Wave 9

1. `GET /admin/pricing/models/:model` melaporkan `catalog` = harga override (memakai
   `priceView(model,1).base`). Diperbaiki memakai `catalogPriceFor(model)`.
2. `sell_cost_micros` pernah disetel sama dengan markup, bukan hasil kali. Diperbaiki menjadi
   `CAST(ROUND(COALESCE(cost_micros,0) * ?) AS INTEGER)`.
3. `startJobWorker()` meng-`unref` pengatur waktunya sehingga proses worker tanpa HTTP keluar sendiri.
   Diperbaiki dengan denyut yang tidak di-`unref` di `worker.ts`.
4. `ensureRecurringJobs()` menjadwalkan pekerjaan berkala dengan waktu "sekarang" (beberapa milidetik
   di depan waktu acuan putaran), sehingga pekerjaan yang baru dijadwalkan tidak ikut diambil pada
   putaran yang sama. Akibatnya putaran pertama saat server menyala tidak menjalankan pekerjaan
   berkala dan uji Wave 8 bisa berlomba dengan pekerjaan retensi. Diperbaiki dengan `runAfter: now`.
5. **Ditemukan oleh gerbang deploy, bukan oleh uji lokal.** Gerbang rehearsal pada deploy pertama
   v0.19.0 berhenti dengan `MIGRATION_REHEARSAL_FAILED 1` dan `DEPLOY_ABORTED`. Laporan menunjukkan
   `ROW_COUNTS_PRESERVED false` dengan nilai "sebelum" `-1` untuk SETIAP tabel. Sebabnya: alat
   rehearsal membuka berkas cadangan asli secara hanya-baca, sedangkan gerbang deploy memasang volume
   cadangan dengan `:ro`. SQLite menolak membuka basis data mode WAL di tempat hanya-baca karena ia
   ingin membuat berkas `-shm` di sampingnya. Bukti langsung di lingkungan lokal: berkas basis data
   mode WAL di direktori hanya-baca, dibuka `{ readonly: true }` sebagai pengguna bukan root →
   `READ_FAILED attempt to write a readonly database`; berkas yang sama di direktori yang bisa
   ditulis → berhasil. Diperbaiki: salinan dibuat LEBIH DULU, jumlah baris dibaca dari salinan
   (`chmod 644` pada salinan, karena `copyFileSync` mewarisi mode `0444` dari aslinya), dan bila ada
   jumlah baris yang tetap tidak terbaca, laporan menyebutkannya sebagai masalah yang jelas, bukan
   sebagai selisih baris yang membingungkan. Diuji ulang persis pada kondisi gagal (direktori 0555,
   berkas 0444, pengguna `nobody`) → `ROW_COUNTS_PRESERVED true`, `MIGRATION_REHEARSAL_OK`.
   `worker-split.e2e.ts` menambah 4 pemeriksaan (21/21) yang memastikan berkas asli tidak pernah
   berubah ukuran, mode, maupun waktu ubahnya.

## Urutan kerja

B (harga) → C (gerbang migrasi) → D (worker) → E (tanpa henti) → F (uji, dokumen, commit, deploy,
smoke, laporan).
