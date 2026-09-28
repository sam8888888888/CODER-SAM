# CODER-SAM — platform Coder SAM University

Kode platform yang melayani **https://coder.sam.university** (aplikasi "COBLAI Coder").
Repo ini berisi **versi terbaik** yang sudah diuji dan di-deploy: rilis **v0.24.2** (27 Sep 2026).

## Isi repo

| Folder | Peran |
|---|---|
| `coder-platform/` | API + mesin agen (Fastify 5 + better-sqlite3, ESM). 61 suite uji E2E. |
| `coder-dashboard/`   | Antarmuka dashboard (Vite + React + TypeScript), termasuk gerbang uji peramban `e2e/ui.e2e.mjs`. |
| `deploy/`            | Skrip deploy server Austria: `deploy-austria.sh` (deploy tanpa mati), `buat-paket.sh` (bangun paket rilis), `env-sync.sh` + `env.keys.txt` (gerbang kunci `.env`), `nginx-sync-csp.sh`, `ops/` (bantuan reset sandi). |
| `docs/`              | Catatan lokal dashboard. Dokumentasi status rilis ada di `coder-platform/docs/`. |

## Menjalankan uji

```bash
cd coder-platform
npm ci
npm run verify          # seluruh suite (harus berakhir ALL_SUITES_PASSED)
```

Gerbang UI dashboard dijalankan terpisah:

```bash
cd coder-dashboard
npm ci && npm run build
node e2e/ui.e2e.mjs     # harus berakhir UI_E2E_PASSED
```

## Membangun paket + deploy

```bash
deploy/buat-paket.sh 0.24.2      # paket dari berkas yang SUDAH di-commit
deploy/deploy-austria.sh 0.24.2  # deploy ke produksi (butuh izin; tanpa mati)
```

Aturan rilis: versi dinaikkan di `deploy/env.keys.txt` (`APP_VERSION`) **dan**
`coder-platform/.env.austria.example`, kunci `.env` baru wajib ditambahkan di kedua berkas itu.

## Hubungan dengan chat.coblai.com

`coder.sam.university` adalah **versi baru** dari `chat.coblai.com` dan disiapkan untuk
**menggantikan** layanan lama itu. Setelah platform ini sempurna, `chat.coblai.com` dipensiunkan.

Karena itu repo ini **hanya berisi kode platform baru** (`coder-platform/`, `coder-dashboard/`,
`deploy/`). Kode aplikasi lama `chat.coblai.com` (`server/`, `web/`, `web-new/`, `_snapshots/`)
**tidak** disertakan supaya tidak tumpang tindih — salinan lamanya tetap tersimpan di repo kerja
lokal sebagai bahan rujukan/rollback sampai layanan lama benar-benar dipensiunkan.

Riwayat commit di repo ini dipertahankan. Berkas proyek lama dibuang dari setiap commit, dan
`README.md` asal (yang khusus menjelaskan chat.coblai.com) diganti dengan README ini.

## Rahasia

Tidak ada kredensial di repo ini. Nilai rahasia hanya ada di `.env` di server dan diabaikan git
(`.env`, `*.key`, `*.pem`, `*token*`). Jalankan `deploy/env-sync.sh` untuk memeriksa kelengkapan kunci.
