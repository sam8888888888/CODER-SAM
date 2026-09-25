# COBLAI Coder Platform

Platform baru ini berdiri sendiri. `chat.coblai.com` hanya menjadi referensi kemampuan, bukan struktur internal. Prime Agent diperlakukan sebagai engine di belakang `AgentEngine` adapter.

## Runtime awal

- Satu container aplikasi untuk API + static web + SQLite.
- Engine Prime Agent tetap service terisolasi.
- SQLite memakai WAL dan backup file database.
- Semua data aplikasi berada di `data/coder.db`; backup berada di `backups/`.

## Backup dan restore

```bash
npm run backup
npm run restore -- backups/coder-YYYY-MM-DDTHH-MM-SS.sssZ.db
```

Restore wajib dilakukan saat API berhenti dan setelah backup current database dibuat.

## Batas keamanan

- Jangan commit `.env`, database, atau backup.
- Jangan mount volume instance `chat.coblai.com`.
- Jangan expose SQLite atau engine port ke internet.
- Auth dan authorization harus selesai sebelum endpoint data dibuka ke publik.


## Integrasi pihak ketiga (Wave 11C, butir 68/71/82)

Tiga aturan yang mengikat seluruh integrasi keluar (`wave11c/notion.ts`, `wave11c/connectors.ts`,
`wave11c/connector-outbound.ts`):

1. **Rahasia tidak pernah keluar dari dinding rahasia.** Token Notion dan konfigurasi konektor
   disimpan terenkripsi di tabel (`user_integrations.secret_ciphertext`,
   `connectors.config_ciphertext`) memakai `secrets.ts`. API hanya pernah mengembalikan penanda
   terpasang dan ekor rahasia, tidak pernah nilainya. Ekspor data pengguna (`dataexport.ts`) juga
   hanya memuat penanda itu.
2. **Hanya host yang diizinkan yang boleh dihubungi.** Semua panggilan keluar lewat satu pintu
   (`connector-outbound.ts`) yang memeriksa host terhadap `CONNECTOR_ALLOWED_HOSTS` dan mematikan
   permintaan setelah `CONNECTOR_TIMEOUT_MS` (bawaan 15 detik). URL di luar daftar ditolak sebelum
   soket dibuka.
3. **Pengiriman berjalan di proses anak terpisah dengan batas waktu keras.** Setiap kirim adalah satu
   pekerjaan `jobs.kind='connector.deliver'` yang dijalankan `wave11c/connector-job.ts` dengan
   `spawn`: proses anak (`wave11c/connector-child.ts`) hanya menerima satu objek JSON di stdin,
   hanya mewarisi daftar variabel lingkungan yang sempit, tidak bisa membuka basis data platform,
   dan dibunuh paksa (`SIGKILL`) saat melewati batas waktu. Jadi tidak ada kode pihak ketiga yang
   berjalan di proses API. Proses yang menjalankan pekerjaan ini mengikuti aturan pekerja umum
   (`JOB_WORKER_IN_WEB`: di dalam proses web, atau di proses pekerja khusus `worker.ts` bila
   dimatikan); isolasi tetap berlaku di kedua kasus. Kegagalan satu konektor tidak pernah
   menggagalkan permintaan pengguna (`connectors.status`/`last_error` dicatat, `GET /health` tetap
   sehat).

## Identitas kanal bot (Wave 11C, butir 69/70/81)

Satu kanal bot (`bot_channels`) melayani banyak pengguna. Pemisahan akun ditegakkan oleh tabel
`bot_identities` dengan batas unik `(channel_id, external_id)`: **satu identitas luar hanya boleh
terpaut ke satu akun**. Penautan memakai kode sekali pakai (`BOT_LINK_CODE_TTL_MINUTES`, bawaan 10
menit; maksimum `BOT_LINK_MAX_ATTEMPTS` percobaan), dan kode disimpan sebagai hash — bukan teks
biasa. Webhook masuk divalidasi: Telegram lewat `X-Telegram-Bot-Api-Secret-Token` per kanal,
WhatsApp lewat tanda tangan HMAC-SHA1 Twilio. Balasan bot dipotong pada `BOT_REPLY_MAX_CHARS`
(bawaan 3500) dan, bila Markdown ditolak hulu, dikirim ulang sebagai teks biasa. Balasan dikerjakan
lewat pekerjaan `bot.reply` supaya webhook tetap menjawab cepat.

## Percakapan grup multi-agen (Wave 11C, butir 73)

`conversations.kind` memisahkan percakapan biasa (`solo`) dari percakapan grup (`group`), dan
`conversation_participants` memuat agen yang ikut berbicara (maksimum `GROUP_MAX_PARTICIPANTS`,
bawaan 4). Satu giliran grup (`POST /api/v1/group-conversations/:id/turns`) menghasilkan **satu**
run yang memuat seluruh peserta, sehingga batas biaya tetap satu run per giliran.

## Nominal unik dan kupon percobaan (Wave 11C, butir 74/75)

- **Nominal unik (butir 74)** hanya untuk pesanan transfer manual. `orders.unique_amount_idr` diisi
  dengan tambahan 3 digit unik (`UNIQUE_AMOUNT_MAX_TRIES` percobaan, bawaan 20); pesanan lewat
  gerbang pembayaran tidak pernah diubah nominalnya.
- **Kupon percobaan (butir 75)** adalah baris `coupons` biasa dengan penanda `trial = 1`,
  `percent = 100`, masa berlaku `TRIAL_COUPON_HOURS` (bawaan 24 jam), dan `trial_plan_code` yang
  menentukan satu paket sasaran. Penegakan `TRIAL_PLAN_ONLY` ada di `billing.ts`
  (`validateCoupon(code, amountIdr, planCode)`), jadi rute lama `POST /api/v1/billing/orders` pun
  patuh — bukan hanya rute kupon yang baru.

## Avatar pengguna dan agen (Wave 11C, butir 76)

Berkas avatar diperiksa jenisnya dari isi (bukan dari nama berkas), dibatasi
`AVATAR_MAX_BYTES` (bawaan 4 MB), dipotong persegi `AVATAR_SIZE` (bawaan 512 px), dan disimpan di
bawah `DATA_DIR/avatars`. **PNG ditulis ulang dari nol** memakai `node:zlib`
(`wave11c/image-sanitize.ts`): seluruh chunk tambahan dibuang dan CRC dihitung ulang, sehingga
metadata tersembunyi tidak ikut tersimpan. **JPEG dan WebP ditolak** dengan
`503 IMAGE_PROCESSOR_UNAVAILABLE` selama belum ada pemroses gambar terpasang — berkas mentah tidak
pernah disimpan. Ini batas jujur yang harus dicabut bila `sharp` (atau pemroses lain) disetujui.

## Versi mesin hanya dibaca (Wave 11C, butir 78 tahap 1)

`GET /api/v1/admin/engine/version` melaporkan `engineVersion`, `platformVersion`, dan `startedAt`
untuk admin. Mesin yang tidak melaporkan versinya ditampilkan sebagai `versi tidak dilaporkan`,
bukan ditebak. **Tahap 2** (memperbarui dan mengembalikan versi mesin) tidak dibuat dan menunggu
keputusan K5.

### Catatan sambungan (keputusan integrasi)

- **Pengurai badan `application/x-www-form-urlencoded` (butir 70).** Fastify bawaan menjawab `415` untuk tipe isi itu, padahal Twilio memang mengirimkannya ke webhook WhatsApp. Modul bot mendaftarkan pengurai sendiri di dalam `registerWhatsappBotRoutes` (`app.addContentTypeParser(..., { parseAs: "string" })`) dan membungkusnya `try/catch` supaya tidak bentrok bila pemanggil lain sudah mendaftarkan tipe yang sama. `server.ts` tidak perlu tahu.
- **Penjaga pemakaian ruang kerja dipindah.** `workspaceGuards`, `workspaceSpend`, dan `guardWorkspaceUsage` dulu fungsi lokal di `server.ts` (yang tidak mengekspor apa pun). Sejak Wave 11C ketiganya tinggal di `apps/api/src/workspace-guard.ts`, sehingga jalur baru (mis. giliran percakapan grup) bisa memakai penjaga yang sama. Setiap jalur yang membuat run wajib melewatinya.
- **Proses anak konektor dijalankan langsung.** `connectorChildCommand()` memakai `process.execPath` ke berkas anak (Node 22 punya `process.features.typescript`), bukan pembungkus `tsx`. Alasan: dengan pembungkus, proses yang benar-benar bekerja menjadi cucu proses, sehingga `SIGKILL` induk hanya membunuh pembungkusnya (terukur 31 detik, padahal batas 3,5 detik). Di produksi berkasnya `.js` hasil build dan dijalankan langsung.

## Matriks perilaku (Wave 11B, butir 83)

Tiga aturan menentukan apa yang boleh terjadi bila fitur bertemu. Aturan ini hidup di
`apps/api/src/wave11b/behavior-matrix.ts` dan dipakai bersama oleh jadwal (butir 72), resume run
(butir 63), dan jalur percakapan. Setiap aturan punya uji tersendiri di
`apps/api/test/wave11b.e2e.ts`; kombinasi diuji, bukan diasumsikan.

### ① MODE_DISKUSI_MENANG — mode diskusi mengalahkan otonom dan jadwal

- Percakapan bermode `diskusi` TIDAK PERNAH menghasilkan run dari jadwal. Perintah jadwal
  dilewati, waktu jalan berikutnya tetap dimajukan supaya tidak mencoba berulang-ulang, dan
  alasannya dilaporkan apa adanya (`MODE_DISKUSI`).
- `POST /api/v1/schedules/:id/run-now` menjawab `200 {dijalankan:false, alasan:"MODE_DISKUSI"}`
  alih-alih membuat run.
- Resume otomatis juga melewati run yang berasal dari percakapan mode diskusi.
- Uji: `wave11b.e2e.ts` §11c-11i.

### ② OTONOM_WAJIB_PENANDA — otonom harus diminta, bukan diwarisi

- Jadwal berjalan sebagai run biasa kecuali jadwal itu sendiri menyetel `autonomous: true`.
- Bawaan akun (`agent_settings.autonomous_default`) TIDAK boleh menyulap jadwal menjadi otonom:
  modul jadwal mengirim `autonomous: false` secara eksplisit.
- Bukti yang dipakai di uji adalah gema mesin (`"autonomous":null` vs `"autonomous":{"maxTurns"...}`)
  dan kolom `runs.autonomous`.
- Uji: `wave11b.e2e.ts` §11j-11m.

### ③ PERSONA_SESI_WAJIB_JEJAK — persona sesi boleh menimpa, tetapi harus berjejak

- Persona yang dikirim bersama satu pesan boleh berbeda dari persona percakapan. Yang dipakai run
  adalah persona sesi.
- Setiap penimpaan menulis satu baris audit `persona.session_override` berisi persona percakapan dan
  persona sesi.
- Persona yang sama dengan persona percakapan, atau pesan tanpa persona, TIDAK menulis jejak.
- Uji: `wave11b.e2e.ts` §11n-11s.

Ringkasan mesin: `matrixSummary()` mengembalikan daftar aturan aktif dan jumlah jejak penimpaan
persona, dipakai oleh uji dan oleh pemeriksaan manual.

## Resume run terputus (Wave 11B, butir 63)

- `run.reap` menandai run yang ditinggalkan proses sebagai `failed` + `WORKER_LOST` +
  `resume_state='resumable'`; pekerjaan yang sudah berjalan tidak diulang begitu saja.
- Resume membuat run BARU (`resumed_from` menunjuk run lama) yang memakai ringkasan percakapan
  terakhir dan melarang mengulang langkah yang sudah selesai. Biaya run lama tidak pernah diubah,
  jadi tidak ada penggandaan biaya.
- Percobaan otomatis dibatasi `RESUME_MAX_AUTO_ATTEMPTS` (bawaan 1). Lanjutan yang gagal lagi
  berhenti dengan alasan `LANJUTAN_DARI_LANJUTAN` supaya tidak ada rantai tanpa akhir; sisanya
  menunggu keputusan manusia.

## Jadwal prompt bebas (Wave 11B, butir 72)

- Baris disimpan di `prompt_schedules`; karena `cron.ts` hanya mengenal UTC, penambahan
  `zoneOffsetMs()`/`nextRunInZone()` membuat waktu dihitung di zona pengguna (bawaan
  `Asia/Jakarta`) dan tetap benar saat pergantian waktu musim.
- Batas `SCHEDULE_LIMIT` (bawaan 10) per akun. Pemindai `schedule.run` dipanggil pekerja antrean;
  mesin yang sama dipakai ulang oleh tombol "jalankan sekarang".

## Local engine mode

Set `MOCK_ENGINE=true` only for local functional tests. It never calls a model provider. Production must use a validated Prime Agent adapter configuration; the application does not guess the RPC wire format.
