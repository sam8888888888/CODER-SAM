# Catatan versi — 12 Sep 2026 (penting sebelum perombakan)

## Temuan

Saat pencadangan, ditemukan **perbedaan antara kode sumber di server dan berkas yang
benar-benar dilayani ke pengunjung web**:

| Berkas | Yang dilayani `chat.coblai.com` | Sumber terlengkap di server | Selisih |
|---|---|---|---|
| `app.js` | 193.514 B (29 Agu) `cf1f09ac…` | 368.648 B (Sep) `c5e205eb…` | **+175 KB** |
| `index.html` | 96.806 B (29 Agu) `31f7d5e6…` | 125.051 B (Sep) `6ecd9b5f…` | **+28 KB** |
| `styles.css` | 43.434 B | 62.424 B | **+19 KB** |
| `sw.js` (versi cache) | `coblai-v8` | `pah-v58-cad15` | jauh tertinggal |

Bukti: `curl https://chat.coblai.com/app.js` → md5 `cf1f09ac1cc478a5c06e50fc3a770eb9`
(identik dengan berkas di dalam container web), sedangkan penanda fitur September
(Quotes/Reply, `Token: X · Biaya: RpY`, kartu tool, streaming live) **tidak ada** di berkas
yang dilayani publik.

## Dugaan penyebab (perlu diverifikasi lanjut)

Container web dibuat ulang pada 10 Sep 2026 (perubahan pengikatan port ke `127.0.0.1:3102`)
memakai image `coblai-chat:branded-20260829-v8`. Berkas frontend yang sebelumnya disalin ke
dalam container (perbaikan September) **hilang** karena image hanya memuat build 29 Agustus.
Akibatnya perbaikan frontend September tidak tampil di web, walau salinannya masih utuh di
folder sumber di server.

## Implikasi untuk perombakan total

1. Jangan berpatokan pada "yang tampil di web" — **kode di `web/` pada repo ini jauh lebih baru**
   dan memuat perbaikan September.
2. Container web sebaiknya dibangun ulang dari sumber (`deploy/Dockerfile.chat` + `web/`), bukan
   memakai image lama, supaya sumber dan produksi tidak terpisah lagi.
3. Cara paling aman: pisahkan berkas statis dari image aplikasi (mount/volume atau CDN),
   sehingga perubahan tampilan tidak ikut hilang saat container dibuat ulang.
