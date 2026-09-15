# RENCANA WAVE 7 (v0.17.0) — TEMA: PERTUMBUHAN

Disetujui oleh Bapak: "KERJAKAN WAVE 7 DULU. SEMUA MASALAH DAN YANG BELUM BERES, DIKUMPULKAN,
NANTI TERAKHIR KITA BERESKAN SATU PER SATU."

Basis: v0.16.0 Wave 6 live (commit 6f80642, skema 14, 179 rute, runner 26 suite, smoke 144 cek).

## Sasaran

Membuat platform bisa TUMBUH SENDIRI: pengguna baru cepat aktif, pengguna lama mengajak orang,
dan pemilik platform bisa melihat angkanya.

## Pekerjaan A — Program Rujukan (referral)
- Tabel baru: `referral_codes` (code unik per pengguna) dan `referrals`
  (inviter, invitee, kode, status pending|qualified|rewarded|blocked, ip, waktu).
- `POST /api/v1/auth/register` menerima `ref` (kode rujukan).
- Anti-penyalahgunaan: tidak boleh merujuk diri sendiri; bila IP pendaftaran invitee sama
  dengan IP pendaftaran inviter -> status `blocked` alasan SAME_IP; hadiah hanya keluar
  setelah invitee menyelesaikan RUN BOT PERTAMA.
- Hadiah kredit memakai `grantCredit` yang sudah ada. Angka dari env
  `REFERRAL_INVITER_TOKENS`, `REFERRAL_INVITEE_TOKENS`, `REFERRAL_ENABLED`.
- API: `GET /api/v1/referrals/me`, `GET /api/v1/referrals`, `POST /api/v1/referrals/code`
  (buat/putar kode), admin: `GET /api/v1/admin/referrals`.
- UI: halaman "Ajak teman" (`Referrals.tsx`) + dukungan `/?ref=KODE` di App.tsx.

## Pekerjaan B — Analitik Pertumbuhan (funnel & retensi)
- Tabel baru `growth_events` (nama peristiwa, user, workspace, properti JSON, waktu) + indeks.
- Modul `growth.ts`: `recordGrowthEvent()` (tidak pernah melempar), `funnelReport(days)`,
  `dailyActivity(days)`, `retentionReport()`, `growthOverview()`.
- Peristiwa dicatat di titik nyata: signup, email verified, proyek dibuat, percakapan dibuat,
  run selesai/gagal, kunci API dibuat, webhook dibuat, order dibuat/dibayar, rujukan joined/rewarded.
- API: `GET /api/v1/admin/growth?days=30` (admin saja).
- UI: halaman admin "Pertumbuhan" (`Growth.tsx`): corong pendaftaran -> proyek -> run -> bayar,
  aktivitas harian, retensi, ringkasan rujukan.

## Pekerjaan C — Onboarding Aktivasi
- Tabel `onboarding_state` (per pengguna: dismissed_at).
- `GET /api/v1/onboarding` -> langkah dengan penanda selesai dihitung dari basis data
  (verifikasi email, buat proyek, run pertama, kunci API pertama, undang rekan, webhook pertama)
  + `progress` + `nextStep`.
- `POST /api/v1/onboarding/dismiss`.
- UI: kartu "Langkah awal" (`Onboarding.tsx`) tampil di Home, disembunyikan bila sudah ditutup
  atau semua langkah selesai.

## Pekerjaan D — Permukaan Publik & SEO (akuisisi)
- `GET /robots.txt` dan `GET /sitemap.xml` dari API (daftar halaman publik: /, /harga, /docs).
- Meta Open Graph + Twitter Card di `index.html`; judul dan deskripsi sesuai produk.
- `GET /api/v1/public/docs` (tanpa sesi) -> katalog rute publik + contoh curl untuk pengembang.
- Halaman publik `/docs` (`PublicDocs.tsx`) dapat dibuka tanpa masuk.

## Pekerjaan E — Peringatan Kuota (upsell jujur)
- `GET /api/v1/billing/quota-alert` -> status kuota harian/bulanan + ambang + pesan Indonesia.
- Banner di shell aplikasi bila pemakaian >= 80%: mengarahkan ke halaman Paket.

## Gerbang verifikasi (tidak boleh dilanggar)
1. `npx tsc -p apps/api/tsconfig.json --noEmit` = 0 dan `npx tsc -p tsconfig.app.json --noEmit` = 0.
2. `node apps/api/test/run-all.cjs` -> SEMUA suite hijau (27 suite setelah wave7.e2e.ts).
3. `npx vite build` dan `npm run build:api` sukses.
4. `bash deploy/deploy-austria.sh 0.17.0` -> DEPLOY_OK.
5. `node apps/api/test/production-smoke.mjs` -> PRODUCTION_SMOKE_PASSED.
6. Commit via `git commit -F` + laporan jujur (sebut SKIP/kegagalan apa adanya).

## Catatan kejujuran yang wajib ikut dilaporkan
- Anti-penyalahgunaan rujukan berbasis IP + email TIDAK kuat: penyerang dengan IP berbeda tetap
  bisa membuat akun palsu. Karena verifikasi email belum diwajibkan, batas ini diakui terbuka.
- `growth_events` hanya mencatat sejak Wave 7 dipasang; angka sebelum itu tidak ada (tidak ada
  backfill). Corong akan tampak kosong pada awalnya, itu wajar dan bukan kegagalan uji.
- Halaman uji TIDAK diperiksa tipe oleh tsc (apps/api/tsconfig.json hanya memuat src/**/*.ts).
