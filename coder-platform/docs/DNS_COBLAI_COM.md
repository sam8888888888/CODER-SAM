# RINCIAN DNS DOMAIN coblai.com — untuk dipasang Bapak

Sumber: diperiksa langsung dari server mail (mailcow, host 152.53.67.115) dan dari DNS publik
pada 16 Sep 2026. Alasan: email aplikasi COBLAI Coder dikirim sebagai noreply@coblai.com.
Server mail SUDAH menandatangani surat dengan DKIM (d=coblai.com, s=dkim) — terbukti dari
header surat nyata. Yang kurang hanya catatan DNS-nya, supaya penerima (Gmail dll) bisa
memverifikasi tanda tangan itu.

## 1) Catatan yang perlu ditambah (3 baris)

| No | Jenis | Nama / Host | Nilai (Value) | Prioritas | TTL |
|----|-------|-------------|---------------|-----------|-----|
| 1 | MX | `@`  (yaitu coblai.com) | `mail.ilmupelet.com.` | 10 | 3600 (atau 300) |
| 2 | TXT | `@`  (yaitu coblai.com) | `v=spf1 mx ip4:152.53.67.115 ~all` | - | 3600 (atau 300) |
| 3 | TXT | `dkim._domainkey` | `v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArq6sndYg8ixe8LV+SfYeyfl9lPO9chR+19qsSpNZkDUo7ktMejiNlSYd/pz5ubaFf3YzfJiszpE39uxPMscbz4hhKh09OIsmIZeQdmsNtG1j04p/fdYWDJ4b+zaN0j9eo2ewfyCqoQGk7KAcSePB8h+xgOG7xZUdBwhedbKbslfBLOFCiXqGawUa0hz4zMI1BE6INf25wb1ikdOkY/yodWm7fHQhuyuhnv9uzGyM9NfnBtUEVZ6RqQ6Me2J9SKWoaunT5JowsDL/AECV8Dn+RBnf3jjlp9bhjgDVUjYj9ARbJ1p1qR6DVKZdKqYChZIQhJbCGJxPrwdN+uelw6Uf6QIDAQAB` | - | 3600 (atau 300) |

Catatan penulisan di panel DNS (umumnya sama):
- Kolom "Name/Host" tidak perlu menulis domain lengkap: cukup `@` dan `dkim._domainkey`.
  Kalau panel meminta nama lengkap: `coblai.com` dan `dkim._domainkey.coblai.com`.
- Nilai DKIM panjang (392 karakter) dan biasanya dipotong beberapa baris oleh panel — itu normal,
  selama tidak ada spasi yang ikut masuk.
- JANGAN lupa titik di akhir `mail.ilmupelet.com.` pada beberapa panel (titik = domain absolut).

## 2) Yang SUDAH ada (tidak perlu diubah)

| Jenis | Nama | Nilai saat ini |
|-------|------|----------------|
| TXT | `_dmarc.coblai.com` | `v=DMARC1; p=none;` |
| A | `coblai.com` | `217.216.109.229` (situs lama, tidak diubah) |

Opsional (kalau Bapak mau laporan DMARC mingguan):
`_dmarc` -> `v=DMARC1; p=none; rua=mailto:postmaster@coblai.com`

## 3) Perbandingan dengan domain yang sudah jalan

Domain `ilmupelet.com` di server yang sama sudah punya:
- MX: `10 mail.ilmupelet.com.`
- SPF: `v=spf1 a mx ip4:152.53.67.115 ~all`
- DKIM: `dkim._domainkey.ilmupelet.com` (kunci berbeda)

Untuk coblai.com saya tidak menyalin bagian `a` pada SPF, karena A-record coblai.com
(217.216.109.229) BUKAN server email kita. Karena itu SPF yang saya sarankan memakai
`mx ip4:152.53.67.115` saja.

## 4) Cara memastikan sudah benar (setelah Bapak pasang)

1. Periksa dari mana saja:
   `dig +short MX coblai.com`  -> harus muncul `10 mail.ilmupelet.com.`
   `dig +short TXT coblai.com` -> harus muncul catatan SPF
   `dig +short TXT dkim._domainkey.coblai.com` -> harus muncul catatan DKIM
2. Saya bisa kirim surat uji ke kotak pemeriksa (mis. milik Gmail) lalu memeriksa hasil
   `Authentication-Results`: SPF=pass, DKIM=pass, DMARC=pass.
3. Selama catatan ini belum ada, surat ke Gmail berisiko masuk folder Spam (tidak selalu gagal).

## 5) Catatan jujur

- Kunci DKIM di atas saya ambil read-only dari penyimpanan kunci server mail (Redis mailcow).
  Kunci privatnya TIDAK saya cetak ke laporan, tidak masuk repository, dan tidak saya simpan.
- Saat mengambil kunci, satu baris awal kunci privat (60 karakter pertama) sempat tampil di log
  sesi kerja saya. Tidak ada kunci utuh yang terbaca. Kalau Bapak ingin aman, kunci DKIM
  coblai.com bisa dirotasi kapan saja dari panel mailcow, lalu saya kirim kunci publik yang baru.
- Saya TIDAK menyentuh DNS coblai.com: sesuai keputusan Bapak, Bapak yang memasang.
