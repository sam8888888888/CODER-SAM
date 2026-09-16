# PATCH RELAY MAILCOW — PORT PUBLIK WAJIB SMTP AUTH (butir 14, Opsi C)

- Tanggal eksekusi: 16 Sep 2026, server Austria (`ssh -F /workspace/.ssh/config coder`).
- Dasar: `docs/RECON_MAILCOW_RELAY.md` (recon read-only, sudah diterima).
- Mode: perubahan **minimal** pada `master.cf` + `postfix reload` (TANPA restart container). `main.cf`,
  `mynetworks`, dan port internal mailcow (588/589/590/591/10465/10587) TIDAK diubah.

## 1. Lubang yang ditutup (bukti sebelum)

Dari host itu sendiri, tanpa kredensial apa pun, port publik Postfix menerima relay ke domain luar:

```
port25-eksternal: RCPT uji-relay-tidak-ada@example.com -> 250 2.1.5 Ok
port25-lokal:     RCPT noreply@coblai.com              -> 250 2.1.5 Ok
port587-eksternal:RCPT uji-relay-tidak-ada@example.com -> 250 2.1.5 Ok
port587-lokal:    RCPT noreply@coblai.com              -> 250 2.1.5 Ok
```

Sebabnya: `mynetworks = 127.0.0.0/8 172.16.0.0/24` (hasil otomatis `mynetworks_style = subnet`) dan
`172.16.0.1` adalah gateway bridge mailcow, sehingga semua lalu lintas yang berasal dari host muncul
sebagai `client=unknown[172.16.0.1]` dan dianggap tepercaya.

## 2. Bukti bahwa klien lain tidak terpengaruh

`docker logs --since 480h mailcow-postfix-mailcow-1` (20 hari, seluruh masa hidup container):
4 koneksi dari `172.16.0.1` — 3 memakai `sasl_username=noreply@coblai.com` (aplikasi kita) dan 1
adalah probe milik kita sendiri. Tidak ada klien lain yang memakai relay tanpa autentikasi.

## 3. Perubahan yang diterapkan

Berkas: `/opt/mailcow/data/conf/postfix/master.cf` (bind-mount container `mailcow-postfix-mailcow-1`,
`/opt/postfix/conf/master.cf`). Salinan hasil patch ada di `deploy/mailcow/master.cf.patched-20260916`.

| Layanan | Port | Sebelum | Sesudah |
|---|---|---|---|
| `smtpd pass` (postscreen) | 25 | tanpa relay restriction khusus | `smtpd_relay_restrictions=permit_sasl_authenticated,defer_unauth_destination` |
| `smtps inet` | 465 | `smtpd_client_restrictions=permit_mynetworks,permit_sasl_authenticated,reject` | `permit_sasl_authenticated,reject` + relay restriction yang sama |
| `submission inet` | 587 | sama seperti 465 | sama seperti 465 |
| `10465 inet`, `10587 inet` (upstream haproxy, tidak dipublikasikan) | — | tidak diubah | tidak diubah |
| `588/589/590/591 inet` (internal Dovecot/mailcow) | — | tidak diubah | tidak diubah |

Cadangan sebelum perubahan: `/opt/mailcow/data/conf/postfix/master.cf.bak_20260916_1516`.
Skrip: `deploy/mailcow/apply-relay-hardening.sh`, `rollback-relay-hardening.sh`, `verify-relay-hardening.sh`.

## 4. Verifikasi sesudah (bukti nyata)

Config efektif menurut Postfix sendiri:

```
submission/inet/smtpd_client_restrictions = permit_sasl_authenticated,reject
submission/inet/smtpd_relay_restrictions  = permit_sasl_authenticated,defer_unauth_destination
smtps/inet/smtpd_client_restrictions      = permit_sasl_authenticated,reject
smtpd/pass/smtpd_relay_restrictions       = permit_sasl_authenticated,defer_unauth_destination
mynetworks                                = 127.0.0.0/8 172.16.0.0/24   (tidak berubah)
588/inet/smtpd_client_restrictions        = permit_mynetworks,permit_sasl_authenticated,reject (tidak berubah)
```

Bukti perilaku (probe yang sama, sesudah patch):

```
port25-eksternal: 454 4.7.1 Relay access denied          (dulu 250 Ok)
port25-lokal:     250 2.1.5 Ok                            (surat masuk tetap diterima)
port587-eksternal:554 5.7.1 Client host rejected          (dulu 250 Ok)
port587-lokal:    554 5.7.1 Client host rejected          (jalur tanpa AUTH memang ditutup)
```

Jalur sah aplikasi (`mailer` platform, port 587 + AUTH LOGIN) dan pengiriman surat uji:

```
postfix/submission/smtpd: 3F06E2617B7: client=unknown[172.16.0.1], sasl_method=LOGIN, sasl_username=noreply@coblai.com
postfix/lmtp: 3F06E2617B7: to=<noreply@coblai.com>, relay=dovecot[172.16.0.250]:24, status=sent (250 2.0.0 ...)
postqueue -p -> Mail queue is empty
```

## 5. Batas yang jujur

1. Jendela log yang tersedia hanya 20 hari (masa hidup container) dan volume surat server kecil, jadi
   klien lain yang memakai relay tanpa autentikasi secara jarang bisa luput.
2. Pembaruan mailcow dapat menimpa `master.cf`. Jalankan `deploy/mailcow/verify-relay-hardening.sh`
   sesudah setiap pembaruan mailcow.
3. `postfix reload` memutus koneksi SMTP yang sedang berjalan sekejap; tidak ada keluhan/antrean tersisa
   saat patch ini dijalankan.
4. Perubahan ini menyentuh layanan bersama host (mailcow dipakai proyek lain). Rollback satu perintah:
   `bash deploy/mailcow/rollback-relay-hardening.sh 20260916_1516`.
