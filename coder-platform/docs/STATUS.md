# Status implementasi COBLAI Coder

Terakhir diperbarui: 14 Sep 2026 (versi 0.12.0)

Cara memperbarui berkas ini: jangan menulis dari ingatan. Baca kode lebih dulu, lalu catat buktinya.
Bukti minimum: rute `app.get/post/put/patch/delete` di `apps/api/src/server.ts`, versi schema dan tabel
di `apps/api/src/db.ts`, halaman di `coder-dashboard/src/nav.ts`, dan suite di `apps/api/test/`.
Bila ragu, tulis "belum diverifikasi".

Catatan snapshot: berkas ini diperiksa saat repo sedang diedit, jadi beberapa perubahan belum di-commit
(Wave 2: `server.ts`, `db.ts`, `App.tsx`, `Tools.tsx`, `api.ts`, `styles.css`, `vite.config.ts`, `index.html`).
Jumlah rute `server.ts` saat diperiksa: 115 (30 rute baru v0.11.0 untuk komersial, admin dan webhook; 3 rute Wave 2 untuk lampiran, cabang dan hapus massal).
Bila angka di kode berbeda, jalankan ulang Cara verifikasi.

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

## Belum dibuat

- Billing dan pembayaran: tidak ada kode penagihan atau integrasi penyedia pembayaran.
- OAuth/SSO (Google, GitHub, SAML).
- Notifikasi email atau push: notifikasi hanya di dalam aplikasi.
- Worker/queue persisten, Redis, dan penskalaan horizontal.
- Object storage: artefak disimpan di disk lokal container.
- Ekspor seluruh data pribadi dan kebijakan retensi data.
- `coder-platform/apps/web` masih kosong; UI ada di `coder-dashboard`.
- API publik untuk klien pihak ketiga, sandbox kode, dan halaman harga.

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
