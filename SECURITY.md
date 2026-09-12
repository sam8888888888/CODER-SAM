# SECURITY.md — kebijakan & hasil pemeriksaan

## 1. Komitmen

Repo ini adalah **cadangan publik** kode produk COBLAI. Karena publik, seluruh berkas
diperiksa lebih dulu agar **tidak ada satu pun kredensial** yang ikut tersimpan.

## 2. Yang SENGAJA tidak disertakan

| Kategori | Contoh | Alasan |
|---|---|---|
| Berkas env | `.env`, `.env.bak_*`, `runtime.env` | memuat API key produksi |
| Data runtime | `data/` (`users.json`, `sessions.json`, `audit.jsonl`, `login-sessions.json`) | data & kredensial user nyata |
| Token/bot | `tg_token`, token Telegram/WhatsApp | kredensial transport |
| Cadangan lokal | `*.bak*`, `*.pre_*`, `backups/` | menambah risiko & sampah |
| Modul pihak ketiga | `node_modules/` | bukan kode kita |

## 3. Hasil pemindaian sebelum publikasi (12 Sep 2026)

- **gitleaks v8.30.1** (`gitleaks dir`) atas seluruh berkas repo → 3 temuan, **semuanya positif palsu**:
  komentar kode berbahasa Indonesia berbunyi `// --- Password: lihat/sembunyikan (ikon mata) ---`
  yang pola "Password: <kata>" memicu aturan generik. Nilai rahasia tidak ada.
- Pemindaian pola kredensial (OpenAI/DeepSeek `sk-…`, AWS `AKIA…`, Google `AIza…`, GitHub `ghp_/github_pat_`,
  Slack `xox…`, token bot Telegram `\d{8,12}:AA…`, JWT `eyJ…`, `BEGIN … PRIVATE KEY`,
  URL `https://user:pass@host`) → **0 temuan**.
- Pemeriksaan khusus pembayaran: string `xnd_…` dan `SB-Mid…` yang muncul **hanya** berupa
  *placeholder* pada kolom isian di halaman admin (contoh format), bukan kunci sungguhan.
- Pemeriksaan email, nomor telepon, ID merchant → tidak ada data pribadi; hanya contoh `email@contoh.com`.
- `deploy/docker-compose.yml` memakai referensi `${VARIABEL}` (tanpa nilai), `deploy/Caddyfile`
  memakai `{env.CLOUDFLARE_API_TOKEN}` (tanpa nilai).
- IP pribadi pemilik pada `deploy/Caddyfile` diganti `203.0.113.10` (IP dokumentasi RFC 5737).

## 4. Variabel lingkungan yang dibutuhkan (nama saja, nilai tidak pernah disimpan)

`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `SERPER_API_KEY`, `NOTION_API_KEY`, `FAL_API_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
`TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `PORT`, `NODE_OPTIONS`, `WORKSPACE`, `DATA_DIR`.

## 5. Melaporkan masalah keamanan

Temuan keamanan pada repo ini atau pada layanan `chat.coblai.com` **jangan** dibuka sebagai isu publik.
Hubungi pemilik produk secara pribadi; perbaikan dilakukan sebelum pengungkapan.
Pemeriksaan hanya boleh dilakukan pada aset milik pemilik produk atau dengan izin tertulis.
