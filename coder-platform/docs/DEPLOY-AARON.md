# Paket deploy untuk Aaron

Paket ini untuk `coder.sam.university`. Dinda tidak memiliki SSH; Aaron yang menjalankan langkah server.

## Isi dan verifikasi

1. Verifikasi hash paket sebelum ekstraksi.
2. Pastikan image base tersedia: `coder-agent-engine:0.9.4`.
3. Pastikan network `coder-net` tersedia.
4. Salin paket ke direktori kerja baru, bukan `/opt/coder-agent` lama.
5. Jalankan `npm ci` dan build sesuai `DEPLOY-RECIPE.md` jika artefak build tidak dipakai.
6. Build `Dockerfile.austria`.
7. Pastikan `.env` dibuat dari `.env.austria.example`; jangan masukkan credential ke Git/paket.
8. Jalankan hanya service `coder-platform-app`.
9. Periksa daftar container sebelum dan sesudah; hanya container `coder-*` baru boleh bertambah.
10. Uji `/health`, `/ready`, register, chat, SSE, dan artifact.
11. Konfigurasi Nginx menggunakan `nginx/coder.sam.university.conf`.
12. Jalankan `nginx -t` sebelum reload.

## Catatan engine

Adapter memakai kontrak RPC stdio yang sudah diperiksa dari `hub-server.js`: `prompt`, `message_update.assistantMessageEvent.text_delta`, dan `agent_end`. Prime Agent dijalankan oleh application container dari image `coder-agent-engine:0.9.4`.

Kunci model sengaja tidak disertakan. Pengisian key dan keputusan billing tetap menunggu Papi.

## Jangan dilakukan

- Jangan menyentuh `chat.coblai.com`.
- Jangan memakai volume/container `coblai-*` atau `prime-agent-hub*`.
- Jangan mengaktifkan Telegram/WhatsApp.
- Jangan menyalin data user/billing.
- Jangan menjalankan `docker compose down` pada stack lain.
