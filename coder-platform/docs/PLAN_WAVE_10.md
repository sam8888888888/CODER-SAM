# RENCANA WAVE 10 — v0.20.0 (butir 21–32D dari DAFTAR_MASALAH_TERTUNDA)

Dasar: jawaban Bapak atas "Grup 5/6/7" (16 Sep 2026) — MODE EKSEKUSI: kerjakan sampai selesai.
Nomor butir merujuk `docs/DAFTAR_MASALAH_TERTUNDA.md` bagian 3 (TEKNIS), termasuk 32b/32c/32d.

## Ruang lingkup & keputusan

| Butir | Isi | Keputusan implementasi |
| --- | --- | --- |
| 21 | Berkas uji tidak diperiksa tipe | `apps/api/tsconfig.test.json` (memuat `src/**` + `test/**`) + skrip `npm run typecheck:test`; dipasang sebagai gerbang PERTAMA di `apps/api/test/run-all.cjs` (sebelum migration-check). Semua galat tipe di suite diperbaiki, bukan dimatikan. |
| 22 + 32d | Uji UI peramban | `playwright` + Chromium dipasang (devDependency, tidak masuk image produksi). Suite `coder-dashboard/e2e/ui.e2e.mjs`: menyajikan SPA hasil `vite build` + API lokal (mesin mock), lalu mengklik alur nyata (masuk, navigasi, cari global, halaman admin, notifikasi). |
| 23 | Webhook: riwayat, kirim ulang, urutan | `webhook_deliveries.sequence` (monoton per webhook) + `resend_of`; pengiriman keluar MENUNGGU bila kiriman berurutan lebih awal masih `queued` (`deferred`, dijadwalkan ulang); header `X-COBLAI-Sequence`; rute `POST /api/v1/webhooks/:id/deliveries/:deliveryId/resend`; tombol "Kirim ulang" di UI; pembersihan riwayat lewat retensi (`RETENTION_WEBHOOK_DAYS`, default 30) + tombol bersihkan sekarang (mode kering). |
| 24 | Kuota token kunci API termasuk yang sedang berjalan | `runs.reserved_tokens` diisi saat run dimulai dari kunci API (perkiraan prompt + batas keluaran); `apiKeyUsageToday()` = token selesai + token cadangan run `queued`/`running`; kuota memakai angka itu; UI/API menampilkan `inFlightTokens`. |
| 25 + 32c | Backfill `growth_events` dari tabel asli | `backfillGrowthEvents()` merekonstruksi peristiwa dari tabel nyata (`users`, `projects`, `conversations`, `runs`, `run_usage`, `api_keys`, `webhooks`, `orders`, `referrals`) memakai `created_at` asli; baris ditandai `source='backfill'`; idempoten (kunci unik per (name, entitas)); mode kering + terapkan; dijalankan saat boot (housekeeping) dan bisa dipicu admin. |
| 26 + 32b | Cek perangkat + verifikasi email | Tabel `user_devices` (sidik jari dari UA + `X-Device-Id` yang dikirim klien, di-hash); `auth_sessions.device_id`; perangkat baru → notifikasi + email "perangkat baru"; halaman "Perangkat & sesi" (daftar, ubah nama, cabut → sesi ikut dicabut, tandai tepercaya); rujukan ditolak bila perangkat pengundang = perangkat pengundang baru (`SAME_DEVICE`); gerbang opsional `DEVICE_VERIFY_NEW` (default `off`) yang mewajibkan verifikasi email perangkat baru sebelum aksi AI. Default `off` supaya tidak ada risiko terkunci. |
| 27 | Mode kering + pembersihan berkala | `RETENTION_DRY_RUN` (default `false`) dan `runRetention({dryRun})`; pembersihan data uji smoke: skrip smoke membersihkan sendiri percakapan/run/kunci yang dibuatnya (`SMOKE_KEEP_DATA=1` untuk melewati) + pekerjaan berkala `smoke.cleanup` (`SMOKE_CLEANUP_ENABLED`, `SMOKE_CLEANUP_HOURS`, mode lapor bila belum diaktifkan). |
| 28 | Halaman Metrics + token metrik | `GET /api/v1/admin/metrics` (sesi admin, JSON) untuk UI + halaman "Metrik" (kartu indikator, tabel, tombol segarkan, isian token untuk mengambil teks Prometheus mentah dari `/metrics`). `METRICS_TOKEN` diisi di `.env` produksi. |
| 29 | Pencarian global lintas proyek | `apps/api/src/search.ts`: FTS5 `message_search` (dijaga trigger) + knowledge FTS + `LIKE` untuk proyek/percakapan/artefak/workflow; rute `GET /api/v1/search?q=`; RBAC: hanya ruang kerja tempat pengguna menjadi anggota; UI kotak cari di kepala halaman + halaman "Pencarian" dengan cuplikan. |
| 30 | Bahasa Indonesia saja | Tidak ada i18n. Ditulis sebagai keputusan tetap di dokumen; ditambah uji ringan bahwa pesan galat API baru memakai kalimat Indonesia. |
| 31 | Notifikasi email dan/atau browser push | Email sudah ada (Wave 4) — ditambah jenis `device`/`webhook`. Browser push: `apps/api/src/push.ts` (VAPID dibuat sekali dan disimpan di `platform_settings` kunci `web_push`; langganan di `push_subscriptions`), rute `GET /api/v1/push/key`, `POST /api/v1/push/subscribe`, `DELETE /api/v1/push/subscriptions/:id`, `POST /api/v1/push/test`; service worker `src/sw.ts` (`injectManifest`) menangani `push` + `notificationclick`; tombol aktif/nonaktif di Pengaturan. |
| 32 | Deploy script menambah key `.env` | `deploy/env.keys.txt` (daftar resmi key + komentar) dan `deploy/env-sync.sh` (memakai `--check` untuk pratinjau): menambah key yang belum ada, TIDAK menimpa nilai, melaporkan key usang (`ENV_OBSOLETE_KEYS`), menyimpan cadangan bernomor. Dipanggil dari `deploy/deploy-austria.sh`. |

## Urutan kerja
1. Skema DB 17 → 18 + `config.ts` + `apikeys.ts`/`webhooks.ts`/`retention.ts`/`growth.ts`.
2. Modul baru: `search.ts`, `devices.ts`, `push.ts`.
3. Penyambungan rute di `server.ts` + UI (`api.ts`, `nav.ts`, halaman baru) + service worker.
4. Uji: `tsconfig.test.json` + suite e2e baru (`wave10`, `webhooks-order`, `search`, `devices`, `push`, `growth-backfill`, `apikey-inflight`) + `deploy/env-sync` self-test + Playwright.
5. `npm run verify` → tar v0.20.0 → deploy → smoke produksi → dokumen/laporan.

## Risiko yang dijaga
- Jangan menyentuh `chat.coblai.com`, data lama, atau container lain. Deploy additive.
- `web-push` jadi dependensi produksi → lock file ikut (server membangun image dengan `npm ci --omit=dev`).
- Playwright hanya devDependency dashboard (tidak masuk image produksi).
- Gerbang perangkat baru default `off` supaya tidak mengunci Bapak.
- Smokе produksi tetap menulis data nyata; karena itu pembersihan otomatis wajib dan diuji.
