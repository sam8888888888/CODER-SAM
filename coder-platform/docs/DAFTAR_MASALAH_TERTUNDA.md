# DAFTAR MASALAH & PEKERJAAN TERTUNDA — COBLAI Coder (coder.sam.university)

Dikumpulkan atas perintah Bapak: "SEMUA MASALAH DAN YANG BELUM BERES, DIKUMPULKAN,
NANTI TERAKHIR KITA BERESKAN SATU PER SATU."

Versi platform saat daftar ini dibuat: **v0.17.0 (Wave 7 — Pertumbuhan)** — versi ini belum di-deploy saat daftar ditulis.
Legenda status: [BAPAK] butuh keputusan/izin Bapak · [TEKNIS] pekerjaan teknis yang bisa saya kerjakan ·
[FITUR] fitur yang belum ada · [RISIKO] temuan yang berpotensi berbahaya.

---

## 0. STATUS KEPUTUSAN BAPAK (jawaban bertahap, 16 Sep 2026)

Keputusan yang sudah diterima (butir 1-5) dan hasilnya di produksi:

| Butir | Keputusan Bapak | Status | Bukti |
|-------|-----------------|--------|-------|
| 1 | Nyalakan email notifikasi | SELESAI | `NOTIFY_EMAIL_ENABLED=true` di `.env` produksi; restart; surat uji ke `noreply@coblai.com` MASUK ke kotak (subjek "Verifikasi email COBLAI Coder"); smoke 156 lulus |
| 2 | Retensi 12 bulan + akun bisa dihapus sendiri | SELESAI | `RETENTION_ENABLED=true`, audit 365 h, notifikasi 365 h, run_events 365 h, ekspor 30 h, token kedaluwarsa 1 h; hapus akun sendiri SUDAH ADA (Profil -> Hapus akun) dan diuji nyata di produksi (`{"ok":true,"deletedWorkspaces":1}`) |
| 3 | Bapak memasang DNS sendiri | TINDAK LANJUT BAPAK | Rincian dikirim: `docs/DNS_COBLAI_COM.md` (MX, SPF, DKIM) |
| 4 | Pakai Midtrans saja | SEBAGIAN | Kunci produksi tersimpan di `.env` produksi dan tervalidasi ke API Midtrans (Snap menjawab 400 validasi = kunci sah; sandbox menolak 401). Penagihan otomatis (pembuatan transaksi Snap + verifikasi tanda tangan webhook) BELUM ada -> pekerjaan berikutnya; gateway masih `manual` |
| 5 | Matikan tombol Google | SELESAI | Tidak ada tombol "Masuk dengan Google" di UI (hanya nama aplikasi authenticator) |

Butir 1, 2, 5 tidak lagi masuk daftar tunggu. Butir 6 (kebijakan hapus akun) dijawab: pengguna
boleh menghapus sendiri - sudah jalan. Butir 7, 8 masih menunggu keputusan.

## 1. MENUNGGU KEPUTUSAN BAPAK

1. [BAPAK] Aktifkan pengiriman email (`NOTIFY_EMAIL_ENABLED=false`). SMTP sudah terpasang dan
   pernah diuji end-to-end, tetapi masih mati; akibatnya email reset sandi/verifikasi hanya
   masuk antrean.
2. [BAPAK] Aktifkan retensi otomatis (`RETENTION_ENABLED=false`) atau tetapkan kebijakan lama
   simpan data (pesan, artefak, ekspor, riwayat pengiriman webhook).
3. [BAPAK] Publikasikan DNS `coblai.com`: SPF, DKIM (kunci publik sudah diekstrak), dan MX.
   Tanpa ini email dari `noreply@coblai.com` berisiko masuk spam.
4. [BAPAK] Kunci gateway pembayaran (Xendit/Midtrans). Tanpa kunci, aktivasi paket ditolak
   `400 GATEWAY_NOT_CONFIGURED`; pembayaran hanya bisa manual lewat transfer + bukti.
5. [BAPAK] Google OAuth client id/secret bila ingin tombol "Masuk dengan Google" berfungsi.
6. [BAPAK] Kebijakan hapus akun: apakah pengguna boleh menghapus akunnya sendiri, berapa lama
   data disimpan, dan apakah wajib ekspor sebelum hapus.
7. [BAPAK] Apakah verifikasi email WAJIB sebelum memakai AI (`email_verified` sekarang tidak
   ditegakkan).
8. [BAPAK] Batas hadiah program rujukan: besaran token untuk pengundang dan yang diundang
   (sekarang usulan awal 500.000 / 250.000 token, dapat diubah lewat env).

## 2. MENUNGGU IZIN BAPAK (aksi berisiko di produksi)

9. [BAPAK] Nyalakan `CSRF_STRICT` di produksi (sekarang hanya lapisan Origin/Sec-Fetch-Site).
10. [BAPAK] Buat admin platform kedua agar tidak bergantung pada satu akun.
11. [BAPAK] Prune image Docker milik proyek lain (30,58 GB reclaimable) — bukan milik COBLAI.
12. [BAPAK] Hapus 561 baris `audit_events` jejak uji di workspace Bapak (jejak audit, jadi
    menunggu izin).
13. [BAPAK] Push repository ke GitHub (`github.com/sam8888888888/coblai-dinda`) — belum pernah
    di-push.
14. [BAPAK] Batasi `mynetworks` relay mailcow (temuan 14 Sep: relay menerima surat tanpa
    autentikasi dari jaringan lokal host).

## 3. UTANG TEKNIS

15. [TEKNIS] Batas laju (rate limit) disimpan di memori proses -> hilang saat restart dan tidak
    cocok untuk banyak replika.
16. [TEKNIS] Deploy memakai `--force-recreate` -> ada jeda singkat tanpa ketersediaan (belum
    zero-downtime).
17. [TEKNIS] Antrean pekerjaan masih SATU PROSES (belum ada Redis/broker, belum bagi beban).
18. [TEKNIS] `migration-check.ts` berdiri sendiri, tidak ikut runner suite otomatis.
19. [TEKNIS] Angka biaya AI (`cost_micros`) belum dicocokkan dengan tagihan DeepSeek nyata.
20. [TEKNIS] Timer pembaruan TLS certbot belum diverifikasi (sertifikat habis 11 Des 2026).
21. [TEKNIS] Berkas uji TIDAK diperiksa tipe oleh `tsc` (`apps/api/tsconfig.json` hanya memuat
    `src/**/*.ts`); kesalahan tipe di suite hanya terlihat saat dijalankan.
22. [TEKNIS] Belum ada uji UI otomatis di peramban (Playwright/Chromium tidak tersedia di
    lingkungan kerja ini).
23. [TEKNIS] Webhook: tidak ada pembersihan otomatis riwayat pengiriman, tidak ada tombol kirim
    ulang dari UI, tidak ada jaminan urutan peristiwa.
24. [TEKNIS] Kuota token per kunci API dihitung dari run yang sudah selesai; run yang sedang
    berjalan belum terhitung sampai selesai.
25. [TEKNIS] Pengukuran pertumbuhan (`growth_events`) hanya berlaku sejak Wave 7 dipasang;
    tidak ada backfill data lama.
26. [TEKNIS] Anti-penyalahgunaan rujukan berbasis email unik + IP pendaftaran: lemah terhadap
    akun palsu dengan IP berbeda, dan verifikasi email belum diwajibkan.
27. [TEKNIS] Smoke produksi menulis data uji nyata (satu percakapan di proyek smoke bot setiap
    dijalankan) — perlu pembersihan berkala atau mode kering.
28. [TEKNIS] Belum ada halaman UI untuk `/metrics` (endpoint ada, butuh token).
29. [TEKNIS] Pencarian global lintas proyek belum ada.
30. [TEKNIS] Multi-bahasa (i18n) belum ada; aplikasi hanya Bahasa Indonesia.
31. [TEKNIS] Notifikasi hanya di dalam aplikasi (lonceng); belum ada email/push saat
    `NOTIFY_EMAIL_ENABLED` mati.
32. [TEKNIS] Deploy script menambah key `.env` baru otomatis: perubahan nama key lama harus
    diperiksa manual agar tidak ada key usang tertinggal.

32b. [TEKNIS] Anti-tipuan program undangan masih lemah: penjagaan hanya membandingkan email dan IP
    pendaftaran (`users.signup_ip`). Verifikasi email belum diwajibkan, jadi akun palsu dari IP
    berbeda tetap bisa lolos. Perlu verifikasi email wajib + pemeriksaan tambahan (mis. perangkat).
32c. [TEKNIS] `growth_events` belum diisi ulang untuk data lama (tanpa backfill). Grafik aktivitas
    harian dan retensi karena itu baru terisi sejak v0.17.0 — corong (daftar/proyek/run/bayar) tetap
    berlaku surut karena dibaca dari tabel asli.
32d. [TEKNIS] Tidak ada suite uji untuk lapisan UI (tidak ada Playwright/Chrome di container), jadi
    halaman baru hanya diuji render statis (`render-check-wave7.tsx`) dan tsc.

## 4. FITUR YANG BELUM ADA (dibanding chat.coblai.com versi lama)

33. [FITUR] Integrasi pihak ketiga (mis. GitHub, Slack) selain webhook keluar.
34. [FITUR] Multimodal (unggah gambar/audio untuk percakapan) — lampiran saat ini hanya berkas
    teks.
35. [FITUR] Verifikasi nomor HP / 2FA SMS (TOTP sudah ada).
36. [FITUR] Paket tim/perusahaan dengan kursi berbayar otomatis (billing per anggota).
37. [FITUR] Pusat bantuan/tiket dukungan di dalam aplikasi.

## 5. RISIKO YANG DIPANTAU

38. [RISIKO] Satu admin platform (risiko terkunci). Penjaga LAST_ADMIN ada, tapi tetap titik
    tunggal.
39. [RISIKO] Verifikasi alamat webhook tidak memakai resolusi DNS -> domain yang menunjuk IP
    privat belum diblokir; metadata `169.254.169.254` dan localhost sudah diblokir.
40. [RISIKO] Disk server kerja sering penuh (pernah 99%) -> suite uji bisa gagal `SQLITE_FULL`.
    Perlu pembersihan berkala direktori uji di `/tmp`.

---

### Cara memakai daftar ini
Bapak cukup menyebut NOMOR (mis. "bereskan 15, 17, 24"). Saya kerjakan satu per satu, dengan
bukti uji nyata, dan memperbarui status di berkas ini setelah tiap nomor selesai.
