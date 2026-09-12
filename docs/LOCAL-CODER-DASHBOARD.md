# COBLAI Coder — local preview

Versi baru berada di `web-new/` dan tidak mengubah `web/` lama.

## Preview UI tanpa backend

```bash
node server/local-preview-server.js
```

Buka `http://127.0.0.1:4173/`. Halaman ini menampilkan UI lokal. Karena backend belum diarahkan, login dan chat nyata belum tersedia.

## Preview dengan backend

Jalankan backend pada port yang tersedia, lalu arahkan proxy:

```bash
BACKEND_URL=http://127.0.0.1:3000 node server/local-preview-server.js
```

Gunakan `?auth=1` untuk memaksa dialog login ketika endpoint `/api/me` belum memiliki sesi.

## Catatan

- Frontend menggunakan vanilla JavaScript dan Tailwind CDN sesuai keputusan awal.
- Service worker dan cache menggunakan nama baru agar tidak bercampur dengan `chat.coblai.com`.
- Belum ada perubahan pada Caddy, VPS, database, atau data user produksi.
- Build live dilakukan setelah alur API, autentikasi, billing, upload, dan migrasi diuji di lokal.
