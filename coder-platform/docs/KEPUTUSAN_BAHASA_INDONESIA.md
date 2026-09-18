# KEPUTUSAN TETAP — BAHASA INDONESIA SAJA (butir 30)

Status: **berlaku**. Ditetapkan 17 Sep 2026 atas jawaban Bapak pada "Grup 5/6/7" (16 Sep 2026),
pelaksanaan Wave 10 (v0.20.0).

## Keputusan

1. Seluruh permukaan pengguna platform ini berbahasa **Indonesia saja**. **Tidak ada i18n**:
   tidak ada berkas terjemahan, tidak ada pemilih bahasa, tidak ada kunci pesan berlapis.
2. Setiap jawaban galat API memakai dua bagian:
   - `error` = kode mesin, HURUF BESAR bergaris bawah (mis. `SEARCH_QUERY_TOO_SHORT`) — stabil,
     dipakai UI dan uji;
   - `message` = **satu kalimat Indonesia yang bisa dibaca pengguna**, bukan pengulangan kode.
3. Halaman (React) menampilkan `message` itu apa adanya, atau kalimat Indonesia lain yang lebih
   ramah. Kode mesin tidak pernah ditampilkan sebagai teks utama.
4. Komentar kode, dokumen, dan keluaran uji juga berbahasa Indonesia.

## Pengecualian yang disengaja

- Rute yang harus **menyembunyikan keberadaan** sumber daya menjawab tanpa `message`, hanya kode:
  `GET /metrics` tanpa token yang benar menjawab `404 NOT_FOUND` (tanpa keterangan) supaya keberadaan
  rute metrik tidak bocor. Pengecualian ini hanya untuk kasus seperti itu, bukan alasan umum.
- Nama berkas, nama kolom basis data, nama variabel, dan nama kunci konfigurasi tetap bahasa Inggris
  sesuai kebiasaan teknis yang sudah dipakai repo ini.

## Penjaga

`apps/api/test/wave10-bahasa.e2e.ts` memeriksa butir-butir di atas pada rute baru Wave 10: setiap
`message` benar-benar kalimat Indonesia (bukan kode mentah) dan pengecualian `NOT_FOUND` tetap seperti
yang ditulis di sini. Uji itu ikut otomatis di `npm run verify` karena berpola `*.e2e.ts`.
