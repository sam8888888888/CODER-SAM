# Rencana & catatan Wave 8 (v0.18.0) — "Akun, keamanan masuk, dan batas laju tahan restart"

Dikerjakan 16 Sep 2026 sebagai jawaban atas butir 6–15 dari daftar 43 butir Bapak.
Setiap butir di bawah memuat: apa yang diminta, apa yang dibangun, dan bukti nyatanya.

## Ringkasan perubahan

| Berkas | Perubahan |
| --- | --- |
| `apps/api/src/db.ts` | `SCHEMA_VERSION` 15 → 16. Tabel baru `rate_limit_hits (bucket, hit_at)` + indeks `idx_rate_limit_hits_bucket`. Kolom baru `users.deleted_at`, `users.purge_after`. |
| `apps/api/src/ratelimit.ts` | Ditulis ulang: hitungan batas laju pindah dari memori proses ke tabel `rate_limit_hits` (jendela geser, sapuan tiap menit). Kunci hitungan memakai awalan nama aturan (`login:`, `register:`, `password:`, `api:`, `referral:`). Ditambah `rateLimitStorage()`. |
| `apps/api/src/retention.ts` | `ACCOUNT_RECOVERY_DAYS = 90`. Fungsi baru `closedAccounts()` dan `purgeClosedAccounts()`. `retentionReport()` dan `runRetention()` melaporkan `accountsPurged`, `workspacesRemoved`, `promoted`. |
| `apps/api/src/server.ts` | Gerbang akun (`accountGate`) untuk run, eksekusi workflow, dan pembuatan kunci API; masuk ditolak untuk akun tertutup; `DELETE /api/v1/auth/account` menjadi penutupan lunak wajib ekspor; `POST /api/v1/admin/users/:id/password`; `POST /api/v1/admin/users/:id/restore`; `PATCH /api/v1/admin/users/:id` menerima `email`; `/api/v1/auth/me` melaporkan `emailVerified` dan `accountClosed`; pekerjaan `retention.run` membersihkan berkas. |
| `apps/api/src/config.ts` | `VERIFY_EMAIL_REQUIRED` = `auto` \| `on` \| `off` (bawaan `auto`). |
| `coder-dashboard/src/api.ts` | `deleteAccount(password, exportId?)`, `adminSetUserPassword`, `adminRestoreUser`, `adminUpdateUser` menerima `email`, `AdminUserRow` memuat `deletedAt`/`purgeAfter`. |
| `coder-dashboard/src/ProfilePanel.tsx` | Dua langkah: (1) unduh salinan data, (2) tutup akun. Menampilkan tanggal penghapusan permanen. |
| `coder-dashboard/src/AdminUsers.tsx` | Ubah email, setel kata sandi (otomatis atau pilihan admin), pulihkan akun, lencana "Ditutup". |

## Butir 6 — Akun bisa ditutup sendiri, pemulihan 90 hari

- `DELETE /api/v1/auth/account` sekarang **penutupan lunak**, bukan penghapusan langsung.
- Syarat: frasa `HAPUS AKUN` (`400 CONFIRM_REQUIRED`), kata sandi benar (`403 INVALID_PASSWORD`),
  bukan admin platform terakhir (`409 LAST_ADMIN`), dan **sudah membuat ekspor data dalam 24 jam
  terakhir** (`409 EXPORT_REQUIRED`, `409 EXPORT_TOO_OLD`).
- Setelah ditutup: `deleted_at` dan `purge_after` (= +90 hari) diisi, semua sesi dan token dihapus,
  kunci API dicabut, jejak audit `user.account_closed` ditulis.
- Akun tertutup tidak bisa masuk: `403 ACCOUNT_DELETED`.
- Admin bisa memulihkan lewat `POST /api/v1/admin/users/:id/restore`; sesudah 90 hari lewat
  jawabannya `409 RECOVERY_WINDOW_PASSED`.
- Penghapusan permanen dikerjakan pekerja `retention.run` (setiap 6 jam):
  baris `users` dihapus, workspace yang tidak punya anggota lain ikut dihapus berikut proyek dan
  berkas artefaknya, sedangkan workspace yang masih beranggota dipertahankan dan anggota terlama
  dinaikkan menjadi `owner`.

Bukti: `apps/api/test/wave8.e2e.ts` bagian 4, 5, dan 6 (33 pemeriksaan), `delete-flow.e2e.ts`.

## Butir 7 — Verifikasi email wajib sebelum aksi AI

- `accountGate()` memblokir `403 EMAIL_NOT_VERIFIED` pada: `POST /api/v1/projects/:id/runs`,
  `POST /api/v1/workflows/:id/execute`, dan `POST /api/v1/api-keys`.
- Pesannya kalimat Indonesia dan menyebut cara memverifikasi.
- **Mode**: `VERIFY_EMAIL_REQUIRED=auto` (bawaan) menegakkan gerbang hanya bila server email aktif.
  Alasannya jujur: kalau SMTP mati, pengguna tidak akan pernah bisa memverifikasi, jadi menegakkan
  gerbang akan mengunci semua orang dari fitur AI. Produksi (email hidup) otomatis `on`; mode ini
  juga bisa dipaksa `on`/`off`.
- `POST /api/v1/auth/email/verify/request` (sudah ada) mengirim ulang tautan;
  `/api/v1/auth/me` melaporkan `emailVerified` supaya shell bisa menampilkan tombol kirim ulang.

Bukti: `wave8.e2e.ts` bagian 3 (13 pemeriksaan) dengan `VERIFY_EMAIL_REQUIRED=on`.

## Butir 8 — Hadiah referral tidak berubah

Tidak ada perubahan: 500.000 token untuk pengundang dan 250.000 token untuk yang diundang,
dibayar hanya setelah run pertama orang yang diundang selesai. Konfirmasi, bukan kode baru.

## Butir 9 — CSRF ketat

Penjelasan lengkap ada di `docs/CSRF_STRICT.md`. Ringkas: `CSRF_STRICT=false` (bawaan) memakai
pemeriksaan Origin/Sec-Fetch-Site; `CSRF_STRICT=true` menambah token ganda (cookie + header
`x-csrf-token`). Tidak ada perubahan di Wave 8; menunggu keputusan Bapak apakah mau dinyalakan.

## Butir 10 — Admin kedua, admin bisa ubah email dan menyetel kata sandi

- `PATCH /api/v1/admin/users/:id` menerima `email` (validasi bentuk, `409 EMAIL_EXISTS` bila dipakai
  akun lain). Setelah email diubah, `email_verified` kembali 0 — email baru harus diverifikasi lagi.
- `POST /api/v1/admin/users/:id/password` menyetel kata sandi. Bila kolom `password` kosong, server
  membuat sandi mudah dibaca (kata Indonesia + 4 angka, contoh bentuk: `cerah-tenang-4821`) dan
  mengembalikannya **sekali** di respons. Semua sesi dan token akun itu dihapus.
- `POST /api/v1/admin/users/:id/restore` membatalkan penutupan akun.
- Admin kedua cukup ditambahkan ke env `PLATFORM_ADMIN_EMAILS` (tanpa mengubah baris pengguna).

Bukti: `wave8.e2e.ts` bagian 7 (20 pemeriksaan).

## Butir 11 — Prune image Docker

Rencana dan batas aman ada di `docs/RECON_DOCKER_PRUNE.md`. Hanya menyentuh tag `coder-*`,
dangling milik kita, dan build cache; tanpa `prune -a`, tanpa `container prune`, tanpa
`volume prune`. Menunggu eksekusi pada langkah operasi.

## Butir 12 — Hapus 561 entri audit uji

Akan dijalankan sebagai penghapusan bertarget (per `action` dan per `workspace_id` uji), dengan
salinan cadangan lebih dulu. Belum dijalankan; menunggu langkah operasi.

## Butir 13 — Push ke GitHub

Belum bisa dijalankan: **tidak ada kredensial GitHub** di server (tidak ada SSH key untuk GitHub,
tidak ada token). Selain itu, paket deploy `deploy/*.tar.gz` dan `.sha256` ternyata ikut ter-track
di git; keduanya harus dikeluarkan dari git (`git rm --cached`) dan dimasukkan `.gitignore`.
Rencana: pindai isi working tree, riwayat, dan isi tar untuk memastikan tidak ada rahasia, lalu push.
Butuh fine-grained PAT dengan izin `contents: write`, atau deploy key.

## Butir 14 — Batasi relay mailcow

Rekon ada di `docs/RECON_MAILCOW_RELAY.md`. Temuan utama: postfix mailcow mempercayai
`172.16.0.0/24` sehingga lalu lintas dari host (dan container proyek lain yang keluar lewat host)
di-MASQUERADE menjadi `172.16.0.1` dan boleh relay tanpa autentikasi — lubang lintas-tenant.
Rekomendasi: batasi port publik 25/465/587 agar wajib autentikasi, sementara port internal
(588/589/…) dibiarkan karena dipakai Dovecot dan penerusan internal mailcow. Aplikasi kita tidak
terpengaruh karena memang memakai AUTH di 587. Ini aksi berisiko: perlu persetujuan Bapak, ada
cadangan `master.cf` dan prosedur balik.

## Butir 15 — Batas laju pindah ke basis data

- Hitungan lama hidup di `Map` dalam proses: hilang saat restart dan berbeda antar replika.
- Sekarang setiap hit dicatat satu baris di `rate_limit_hits`, jendela geser tetap sama.
- Kunci hitungan memakai awalan nama aturan supaya aturan yang berbeda tidak saling menjumlah
  (contoh: `login:127.0.0.1:budi@contoh.id` berbeda dari `register:127.0.0.1`).
- Tabel tetap kecil: setiap pemeriksaan menghapus baris yang sudah keluar dari jendela, dan
  sapuan tiap menit membuang baris berumur lebih dari 20 menit.
- `GET /api/v1/status-hub` melaporkan `openPlatform.rateLimits` = `{ store: "database", table, rules }`.

Bukti: `wave8.e2e.ts` bagian 1 dan 2 (22 pemeriksaan), termasuk bukti bahwa menghapus baris dari
tabel langsung membuka blokir (sesuatu yang mustahil bila hitungan ada di memori).

## Verifikasi yang dijalankan

- `npx tsc -p apps/api/tsconfig.json --noEmit` → lulus.
- `npx tsc -p tsconfig.app.json --noEmit` (dashboard) → lulus.
- `npx tsx apps/api/test/wave8.e2e.ts` → 99 pemeriksaan lulus, 0 gagal, 0 lewat.
- `npx tsx --tsconfig tsconfig.app.json render-check-wave8.tsx` → `ALL_WAVE8_PAGES_RENDERED`.
- `npm run verify` → 28 suite.
- Smoke produksi setelah deploy → `PRODUCTION_SMOKE_PASSED`.

## Yang belum selesai (jujur)

- Butir 11, 12, 14 adalah tindakan operasi di server, belum dijalankan.
- Butir 13 terhalang kredensial GitHub.
- Midtrans: alur Snap dan pemeriksaan `signature_key` pada callback belum dibangun, gateway tetap
  `manual`.
- DNS `coblai.com` (MX/SPF/DKIM) masih menunggu pemasangan oleh Bapak.
