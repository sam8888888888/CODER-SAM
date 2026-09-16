# RECON MAILCOW RELAY — Server Austria (read-only)

- **Tanggal recon:** 16 Sep 2026 (UTC 12:32–12:45)
- **Host:** `ssh -F /workspace/.ssh/config coder` → `austria.hostinghemat.com` (user `dinda`, `sudo -n` OK)
- **Yang diperiksa:** mailcow di `/opt/mailcow` (container `mailcow-postfix-mailcow-1`, `mailcow-rspamd-mailcow-1`, `mailcow-mysql-mailcow-1`, `mailcow-redis-mailcow-1`)
- **Sifat pekerjaan:** READ-ONLY. Tidak ada perubahan konfigurasi, tidak ada reload/restart layanan, tidak ada perubahan mynetworks, tidak ada kata sandi yang ditampilkan. Satu-satunya berkas yang dibuat di server adalah berkas sementara `/tmp/dinda_recon_postfix_interesting.log` (untuk menganalisis log) dan berkas itu **sudah dihapus** setelah dipakai.
- **Temuan yang ditindaklanjuti:** "relay mailcow menerima surat tanpa autentikasi dari jaringan lokal host".

---

## 1. Ringkasan eksekutif (5 baris)

1. **Benar.** Relay tanpa autentikasi memang terbuka, dan **bukan** karena subnet proyek lain masuk `mynetworks`, tetapi karena `mynetworks` (hasil otomatis `mynetworks_style = subnet`) berisi **`127.0.0.0/8 172.16.0.0/24`**, sedangkan `172.16.0.1` adalah **gateway bridge mailcow (`br-mailcow`)**. Semua lalu lintas yang berasal dari **host itu sendiri** (proses apa pun di host, termasuk container dari proyek lain yang menghubungi port publik 25/465/587) muncul di Postfix sebagai `client=unknown[172.16.0.1]` → dianggap "mynetworks" → boleh relay tanpa AUTH.
2. Port publik postfix: **25, 465, 587** (`0.0.0.0` + `[::]`), diteruskan `docker-proxy`.
3. **Bukti nyata ada:** pada 14 Sep 2026 04:01:36 tercatat satu pesan **tanpa `sasl_username`** dari `client=unknown[172.16.0.1]` yang **diterima dan masuk queue** (`9D25D260317`), lalu di-relay ke domain luar (`to=<probe-tidak-ada@example.invalid>`). Pesan itu hanya gagal karena domain tujuan tidak ada (DNS), bukan karena ditolak Postfix.
4. **Tidak ada bukti** proyek lain memakai relay tanpa autentikasi: dalam 16 hari log (31 Agu – 16 Sep 2026) hanya ada **4 pesan** yang diterima; 3 di antaranya memakai **AUTH LOGIN** (`sasl_username=noreply@coblai.com`). Pengirim aplikasi lain memakai jalur lain (AWS SES, Resend) atau fitur notifikasi mati.
5. **Rekomendasi:** Opsi C (batasi **port publik saja** agar wajib SMTP AUTH) — paling kecil risiko, menutup lubang, dan aplikasi kita (`coder-platform-app`, port 587 + AUTH) tidak terganggu. Opsi B **sendirian tidak menutup lubang** (lihat §6).

---

## 2. Temuan 1 — Konfigurasi relay efektif Postfix

Perintah (apa adanya):

```
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -n | grep -E "mynetworks|smtpd_relay_restrictions|smtpd_client_restrictions|smtpd_sender_restrictions|smtpd_tls_security_level|inet_interfaces"
```

Keluaran mentah yang relevan:

```
/usr/sbin/postconf: warning: /opt/postfix/conf/main.cf, line 201: overriding earlier entry: inet_protocols=all
inet_interfaces = all
mynetworks_style = subnet
parent_domain_matches_subdomains = debug_peer_list,fast_flush_domains,mynetworks,qmqpd_authorized_clients
postscreen_access_list = permit_mynetworks, cidr:/opt/postfix/conf/custom_postscreen_whitelist.cidr, cidr:/opt/postfix/conf/postscreen_access.cidr, tcp:127.0.0.1:10027
smtpd_recipient_restrictions = check_recipient_mx_access proxy:mysql:/opt/postfix/conf/sql/mysql_mbr_access_maps.cf, permit_sasl_authenticated, permit_mynetworks, check_recipient_access proxy:mysql:/opt/postfix/conf/sql/mysql_tls_enforce_in_policy.cf, reject_invalid_helo_hostname, reject_unauth_destination
smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination
smtpd_sender_restrictions = reject_authenticated_sender_login_mismatch, permit_mynetworks, permit_sasl_authenticated, reject_unlisted_sender, reject_unknown_sender_domain
smtpd_tls_security_level = may
```

**Nilai efektif `mynetworks`** (ini kunci masalahnya):

```
$ sudo -n docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks
127.0.0.0/8 172.16.0.0/24
```

Catatan penting:
- `mynetworks` **tidak ditulis eksplisit** di `main.cf`. Nilainya dihitung otomatis karena `mynetworks_style = subnet` (subnet dari antarmuka container: `lo` → `127.0.0.0/8`, `eth0` → `172.16.0.0/24`).
- `main.cf` baris 1–2: `# Please create a file "extra.cf" for persistent overrides to main.cf`. Isi `extra.cf` di-append oleh `/opt/postfix.sh` (baris 486–491) saat container postfix **start**:
  ```
  486-# Append user overrides
  487-echo -e "\n# User Overrides" >> /opt/postfix/conf/main.cf
  488-touch /opt/postfix/conf/extra.cf
  489-sed -i '/\$myhostname/! { /myhostname/d }' /opt/postfix/conf/extra.cf
  490-echo -e "myhostname = ${MAILCOW_HOSTNAME}\n$(cat /opt/postfix/conf/extra.cf)" > /opt/postfix/conf/extra.cf
  491-cat /opt/postfix/conf/extra.cf >> /opt/postfix/conf/main.cf
  ```
  Artinya: perubahan `main.cf`/`extra.cf` **butuh restart container postfix** agar berlaku; perubahan `master.cf` cukup `postfix reload`.
- `inet_protocols = ipv4` → jalur IPv6 (subnet mailcow `fd4d:6169:6c63:6f77::/64`) tidak aktif untuk Postfix.
- Tidak ada rate limit eksplisit: `postconf -n` tidak memuat `smtpd_client_message_rate_limit` / `smtpd_client_connection_rate_limit`; milter aktif (`smtpd_milters = inet:rspamd:9900`, `milter_default_action = tempfail`), `smtpd_helo_required = yes`, `smtpd_delay_reject = yes`.

### 1b. Definisi per-port (master.cf)

```
2:smtp       inet  n       -       n       -       1       postscreen
3:10025      inet  n       -       n       -       1       postscreen
6:smtpd      pass  -       -       n       -       -       smtpd
8:  -o smtpd_sender_restrictions=permit_mynetworks,reject_unlisted_sender,reject_unknown_sender_domain
12:smtps    inet  n       -       n       -       -       smtpd
14:  -o smtpd_client_restrictions=permit_mynetworks,permit_sasl_authenticated,reject
19:10465    inet  n       -       n       -       -       smtpd
22:  -o smtpd_client_restrictions=permit_mynetworks,permit_sasl_authenticated,reject
30:submission inet n       -       n       -       -       smtpd
31:  -o smtpd_client_restrictions=permit_mynetworks,permit_sasl_authenticated,reject
32:  -o smtpd_tls_security_level=encrypt
37:10587      inet n       -       n       -       -       smtpd
39:  -o smtpd_client_restrictions=permit_mynetworks,permit_sasl_authenticated,reject
48:588 inet n      -       n       -       -       smtpd      <- dipakai Dovecot (submission_host = postfix:588)
56:590 inet n      -       n       -       -       smtpd
58:  -o smtpd_client_restrictions=permit_mynetworks,reject
65:591 inet n      -       n       -       -       smtpd
67:  -o smtpd_client_restrictions=permit_mynetworks,reject
122:589 inet n      -       n       -       -       smtpd
123:  -o smtpd_client_restrictions=permit_mynetworks,reject
117:127.0.0.1:10027 inet n n n - 0 spawn user=nobody argv=/usr/local/bin/whitelist_forwardinghosts.sh
```

Port yang **dipublikasikan ke host** (`docker port`) hanya:

```
25/tcp  -> 0.0.0.0:25   / [::]:25
465/tcp -> 0.0.0.0:465  / [::]:465
587/tcp -> 0.0.0.0:587  / [::]:587
```

Port lain (588, 589, 590, 591, 10025, 10465, 10587, 127.0.0.1:10027) **internal container** — hanya bisa diakses dari dalam jaringan mailcow.

---

## 3. Temuan 2 — Dari jaringan mana saja relay tanpa autentikasi mungkin?

Perintah & keluaran mentah:

```
$ sudo -n docker network inspect -f '{{.Name}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{range $k,$v := .Containers}}{{$v.Name}},{{end}}' $(sudo -n docker network ls -q)
```

Ringkasan yang relevan (32 jaringan total):

| Jaringan | Subnet | Isi | Milik |
|---|---|---|---|
| `mailcow_mailcow-network` | **172.16.0.0/24** (IPv6 `fd4d:6169:6c63:6f77::/64`) | 17 container `mailcow-*` (postfix, dovecot, rspamd, mysql, redis, sogo, ofelia, clamd, nginx, unbound, memcached, olefy, watchdog, acme, dockerapi, postfix-tlspol, netfilter) | **mailcow** |
| `coder-net` | 192.168.192.0/20 | `coder-agent-engine`, `coder-platform-app` | proyek kita |
| `bridge` | 172.17.0.0/16 | `camofox-browser`, `mycampus-api`, `bgutil-provider` | proyek lain |
| `geo-engine-pro_geoep_net` | 192.168.96.0/20 | `geoep-brain-server` | proyek lain |
| `project_geo_store_v2_default` | 172.32.0.0/16 | `geoep-brain-server`, `geo-store-v2` | proyek lain |
| `listmonk_default` | 192.168.176.0/20 | `listmonk`, `listmonk-db` | proyek lain |
| `findbuyer-network` | 192.168.80.0/20 | `findbuyer-*` (7 container) | proyek lain |
| `sam-cover-studio_app`, `sam-labs_default`, `salesandmarketing_default`, `ghost-*`, `ideato*`, `iklanos-*`, `jesse_default`, `rena-net`, `crypto-engine_default`, `hermes-trading_default`, `vibe-trading_default`, `tradingview-mcp_default`, `opend_default`, `wordpress-ilmupelet_default`, `blog-crossborder_default`, `cartesia-rena_rena-network`, `gae-mcp_default`, `gods-eye-view_default`, `spree-net`, `nadine-net`, `findbuyer-*` | 172.18–172.31/16 dan 192.168.0–192.168.192/20 | puluhan container milik proyek lain | proyek lain |
| `host` (network_mode: host) | – | `coblai-command-center`, `sam-os-web`, `myoffice-office`, `myoffice-scheduler`, `myoffice-tenant-pt-maju-jaya`, `myoffice-fleet`, `myoffice-jobs`, `myoffice-studio`, `ibkr-mcp`, `mailcow-netfilter-mailcow-1` | campur |

**Verifikasi penting:** `mailcow_mailcow-network` **hanya berisi container `mailcow-*`**. Tidak ada container proyek lain yang menempel langsung ke jaringan mailcow.

Tetapi ini **bukan** batas aman, karena:

```
$ ip -4 addr show br-mailcow | grep inet
    inet 172.16.0.1/24 brd 172.16.0.255 scope global br-mailcow

$ sudo -n iptables -t nat -S POSTROUTING | grep 172.16
-A POSTROUTING -s 172.16.0.0/24 ! -o br-mailcow -j MASQUERADE
(… 30+ aturan MASQUERADE untuk semua jaringan docker lain, termasuk 192.168.192.0/20 milik coder-net …)

$ sudo -n ss -lntp | grep -E ":25 |:587 |:465 "
LISTEN 0 4096 0.0.0.0:25  0.0.0.0:* users:(("docker-proxy",pid=9263,fd=8))
LISTEN 0 4096 0.0.0.0:465 0.0.0.0:* users:(("docker-proxy",pid=9301,fd=8))
LISTEN 0 4096 0.0.0.0:587 0.0.0.0:* users:(("docker-proxy",pid=9356,fd=8))
```

**Kesimpulan pemetaan:** relay tanpa autentikasi sekarang mungkin dari:

1. **Semua container mailcow sendiri** (172.16.0.x) — memang disengaja (Dovecot memakai `submission_host = postfix:588`; forwarding/alias keluar bergantung pada `permit_mynetworks`). Ini **normal dan dibutuhkan**.
2. **Proses apa pun di host** (root/user mana pun, cron, skrip, operator) yang menghubungi `127.0.0.1:25/465/587` atau `152.53.67.115:25/465/587`. Karena `docker-proxy` + DNAT + MASQUERADE, sumbernya tampak sebagai **172.16.0.1** → masuk mynetworks → boleh relay tanpa AUTH.
3. **Container proyek lain** (semua 30 jaringan lain + container `network_mode: host`) yang menghubungi port publik host (`<IP host>:25/465/587` atau gateway jaringannya) — sumbernya juga di-MASQUERADE ke **172.16.0.1** → boleh relay tanpa AUTH. **Jadi pengaruhnya lintas-tenant**, bukan hanya mailcow.
4. Internet: **tidak** (IP publik luar bukan mynetworks) — terbukti dari log: `Client host rejected: Access denied` untuk `relaycheck_please_ignore@protonmail...` dari IP luar.

---

## 4. Temuan 3 — Bukti nyata di log

Sumber log: `sudo -n docker logs --timestamps mailcow-postfix-mailcow-1` — tersedia, mencakup **31 Agu 2026 09:33 UTC → 16 Sep 2026 12:32 UTC** (≈16 hari; container `Up 7 days`, tapi log ikut volume/restart terakhir 8 Sep 2026 19:03 UTC — tetap mencakup seluruh rentang di atas). `/var/log/mail.log` di dalam container **kosong** (0 byte, mailcow menulis ke stdout).

Perintah & hasil:

```
$ sudo -n docker logs --since 48h mailcow-postfix-mailcow-1 | grep -oE "client=[^,]+" | sort | uniq -c | sort -rn
      3 client=unknown[172.16.0.1]

$ sudo -n docker logs (semua) | grep -oE "client=[^,]+" | sort | uniq -c | sort -rn
      4 client=unknown[172.16.0.1]

$ sudo -n docker logs (semua) | grep -oE "sasl_username=[^,]*" | sort | uniq -c | sort -rn
     20 sasl_username=info@ilmupelet.com              <- AUTH GAGAL dari IP luar (brute force)
     20 sasl_username=info@crossbordermarketplace.com <- AUTH GAGAL dari IP luar (brute force)
      3 sasl_username=noreply@coblai.com              <- AUTH SUKSES (aplikasi kita)
      2 sasl_username=dinda@ilmupelet.com             <- AUTH GAGAL dari 217.216.109.229

$ sudo -n docker logs (semua) | grep -oE "sasl_method=[A-Za-z]*" | sort | uniq -c
      3 sasl_method=LOGIN
```

**Seluruh pesan yang diterima Postfix dalam 16 hari = 4. Rinciannya (mentah):**

```
2026-09-13T20:01:36.64Z Sep 14 04:01:36 4266c2e209d5 postfix/submission/smtpd[11168]: 9D25D260317: client=unknown[172.16.0.1]
2026-09-13T20:01:36.64Z Sep 14 04:01:36 4266c2e209d5 postfix/cleanup[11172]: 9D25D260317: message-id=<>
2026-09-13T20:01:37.45Z Sep 14 04:01:37 4266c2e209d5 postfix/qmgr[367]: 9D25D260317: from=<noreply@ilmupelet.com>, size=695, nrcpt=1 (queue active)
2026-09-13T20:01:37.51Z Sep 14 04:01:37 4266c2e209d5 postfix/smtp[11174]: 9D25D260317: to=<probe-tidak-ada@example.invalid>, relay=none, delay=0.89, delays=0.84/0.04/0/0, dsn=5.4.4, status=bounced (Host or domain name not found. Name service error for name=example.invalid type=A: Host not found)
2026-09-13T20:01:37.53Z Sep 14 04:01:37 4266c2e209d5 postfix/qmgr[367]: 9D25D260317: removed

2026-09-15T05:33:02.08Z Sep 15 13:33:02 4266c2e209d5 postfix/submission/smtpd[21076]: 13F2E260161: client=unknown[172.16.0.1], sasl_method=LOGIN, sasl_username=noreply@coblai.com
2026-09-15T05:33:40.18Z Sep 15 13:33:40 4266c2e209d5 postfix/submission/smtpd[21076]: 2C5092617B7: client=unknown[172.16.0.1], sasl_method=LOGIN, sasl_username=noreply@coblai.com
2026-09-16T03:55:52.90Z Sep 16 11:55:52 4266c2e209d5 postfix/submission/smtpd[25216]: DBA35260161: client=unknown[172.16.0.1], sasl_method=LOGIN, sasl_username=noreply@coblai.com
```

**Interpretasi bukti (siapa, berapa, dari subnet mana):**

| Waktu | Queue ID | Klien | AUTH? | Dari | Ke | Hasil |
|---|---|---|---|---|---|---|
| 14 Sep 04:01:36 (lokal) / 13 Sep 20:01:36Z | `9D25D260317` | `client=unknown[172.16.0.1]` — **tanpa `sasl_method` / `sasl_username`** | **TIDAK** | `from=<noreply@ilmupelet.com>` | `to=<probe-tidak-ada@example.invalid>` | **DITERIMA + masuk queue**, gagal hanya karena domain tujuan tidak ada (DNS), bukan ditolak relay |
| 15 Sep 13:33:02 | `13F2E260161` | `client=unknown[172.16.0.1]` | YA (LOGIN, `noreply@coblai.com`) | `from=<noreply@coblai.com>` | dirinya sendiri (LMTP dovecot) | sent |
| 15 Sep 13:33:40 | `2C5092617B7` | `client=unknown[172.16.0.1]` | YA (LOGIN) | `from=<noreply@coblai.com>` | dirinya sendiri | sent |
| 16 Sep 11:55:52 | `DBA35260161` | `client=unknown[172.16.0.1]` | YA (LOGIN) | `from=<noreply@coblai.com>` | dirinya sendiri | sent |

Jumlah: **1 dari 4** pesan dikirim **tanpa autentikasi** dari `172.16.0.1` (subnet `172.16.0.0/24` = jaringan mailcow; `172.16.0.1` = gateway `br-mailcow` = asal dari host).

Konteks pembanding (klien luar, ditolak dengan benar):

```
2026-09-03T06:29:35Z ... postfix/smtps/smtpd[3042]: NOQUEUE: reject: RCPT from unknown[104.152.52.72]: 554 5.7.1 <unknown[104.152.52.72]>: Client host rejected: Access denied; from=<relaycheck_please_ignore@protonmail...>
2026-09-13T19:52:19Z ... postfix/submission/smtpd[11158]: NOQUEUE: reject: RCPT from vmi3421007.contaboserver.net[217.216.109.229]: 554 5.7.1 ... Client host rejected: Access denied
```

Jadi: **dari luar ditolak, dari 172.16.0.1 (host) diterima** — itu demonstrasi bersih bahwa `mynetworks`-lah yang menjadi pintu masuk. (Pola `relaycheck_please_ignore@protonmail…` dan `probe-tidak-ada@example.invalid` menunjukkan pemeriksaan relay yang sudah pernah dilakukan orang lain terhadap server ini pada 3–14 Sep 2026.)

Bukti pelengkap: **tidak ada** pemakaian jalur lokal `sendmail`/`pickup`/`uid=0` sama sekali (`postfix/sendmail`, `postfix/pickup` tidak muncul di log); 1.815 baris `NOQUEUE` semuanya dari pemindai internet (`lost connection`, `Client host rejected`), bukan dari dalam.

---

## 5. Temuan 4 — Apakah proyek lain bergantung pada relay tanpa autentikasi?

**Bukti dari log (16 hari): TIDAK ADA.** Tidak satu pun baris log menunjukkan klien dari subnet proyek lain (172.17–172.32/16, 192.168.0–192.168.192/20) atau dari `127.0.0.1`. Hanya `172.16.0.1` (host) dan `172.16.0.250` (dovecot, internal mailcow).

**Bukti konfigurasi (nama variabel environment container, nilai rahasia disamarkan):**

| Container | Kunci env terkait mail | Arti |
|---|---|---|
| `coder-platform-app` | `SMTP_HOST=mail.ilmupelet.com`, `SMTP_PORT=587`, `SMTP_USER=noreply@coblai.com`, `SMTP_PASSWORD=***`, `SMTP_SECURE=false`, `SMTP_FROM=COBLAI Coder <noreply@coblai.com>`, `NOTIFY_EMAIL_ENABLED=true` | **Proyek kita memakai SMTP AUTH di port 587** (sesuai log `sasl_method=LOGIN`) → **tidak butuh** relay tanpa autentikasi |
| `coblai-command-center` | `SES_SMTP_HOST=email-smtp.us-east-1.amazonaws.com`, `SES_SMTP_PORT=587` | pakai AWS SES, bukan mailcow |
| `geo-store-v2` | `RESEND_FROM_EMAIL=GEO Engine Pro <noreply@geoenginepro.coblai.com>` | pakai Resend API, bukan mailcow |
| `mailcow-watchdog-mailcow-1` | `WATCHDOG_NOTIFY_EMAIL=` (kosong), `MAILQ_THRESHOLD=20`, `/usr/sbin/sendmail -> /bin/busybox` | notifikasi mailcow **mati**; watchdog tak punya MTA |
| `sam-cover-studio-*`, `mycampus-api`, `sam-os-web` | hanya `ADMIN_EMAIL` / `SAMOS_DEV_EMAIL` | tidak ada kredensial SMTP ⇒ tidak mengirim lewat mailcow |
| `mailcow-*` lain | `MAILCOW_HOSTNAME=mail.ilmupelet.com` | internal mailcow |

**Pengirim lokal-sah yang ditemukan:** hanya `coder-platform-app` (dengan AUTH). Dovecot (`submission_host = postfix:588`) memakai port **internal** 588, bukan port publik.

**Keterbatasan bukti ini:** jendela log hanya 16 hari dan volume surat server ini sangat kecil (4 pesan/16 hari). Pemakai relay yang jarang (laporan bulanan, cron mingguan) bisa tidak terlihat. Beberapa proyek menyimpan konfigurasi SMTP di database (mis. listmonk) sehingga tidak muncul di daftar variabel environment. Lihat §8.

---

## 6. Opsi perbaikan (dari risiko paling kecil)

### Opsi A (usulan awal) — "keluarkan jaringan proyek kita dari mynetworks" → **TIDAK BISA DITERAPKAN SEBAGAIMANA ADANYA**

Alasannya (fakta dari §2–§3):
- `mynetworks` **tidak memuat** `192.168.192.0/20` (`coder-net`). Jaringan kita memang tidak pernah ada di sana.
- Lalu lintas kita masuk sebagai **`172.16.0.1`** (gateway `br-mailcow`) akibat `docker-proxy` + MASQUERADE, dan `172.16.0.1` termasuk `172.16.0.0/24` di `mynetworks`.
- Jadi "menghapus diri sendiri dari mynetworks" tidak menghapus apa pun. Yang harus dihapus adalah **kepercayaan pada sumber host (172.16.0.1 / 127.0.0.0/8) untuk port publik**, dan itu = Opsi C di bawah.

### Opsi B — Batasi `mynetworks` ke subnet mailcow saja → **TIDAK CUKUP (menutup sebagian) dan menambah risiko**

Perintah persis (belum dijalankan):
```
# 1. backup
sudo cp -a /opt/mailcow/data/conf/postfix/extra.cf /opt/mailcow/data/conf/postfix/extra.cf.bak_$(date +%Y%m%d_%H%M)
# 2. tambahkan baris berikut ke /opt/mailcow/data/conf/postfix/extra.cf
mynetworks = 172.16.0.0/24
# 3. extra.cf hanya di-append ke main.cf saat container start → perlu restart container postfix
sudo docker restart mailcow-postfix-mailcow-1
# 4. verifikasi
sudo docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks   # harap: 172.16.0.0/24
```
Rollback: `sudo cp -a .../extra.cf.bak_<tanggal> .../extra.cf && sudo docker restart mailcow-postfix-mailcow-1`.

Konsekuensi & mengapa **tidak cukup**:
- `127.0.0.0/8` hilang ⇒ klien loopback (proses di host yang memakai `127.0.0.1:587`) tidak lagi dianggap mynetworks. Tidak ada pemakai terlihat di log.
- **Tetapi `172.16.0.1` tetap ada di dalam `172.16.0.0/24`** ⇒ jalur "dari host / container proyek lain via port publik" **tetap terbuka**. Lubang utama tidak tertutup.
- Mengganti jadi `mynetworks_style = host` (hanya IP container postfix) **lebih berbahaya**: Dovecot (172.16.0.250) akan kehilangan hak relay → forwarding/alias keluar mailcow rusak.
- Untuk benar-benar mengecualikan gateway `.1` sementara container `.2–.254` tetap dipercaya perlu daftar CIDR berpecah (mis. `172.16.0.2/31 172.16.0.4/30 …`) — rapuh karena Docker mengalokasikan IP dinamis. Tidak direkomendasikan.

### Opsi C — (REKOMENDASI) Wajib AUTH pada port publik saja; `mynetworks` tidak diubah

Ide: port **publik** (25 via postscreen, 465, 587) tidak lagi menerima `permit_mynetworks` untuk relay; port **internal** (588, 589, 590, 591, 10025, 10465, 10587) dibiarkan persis seperti sekarang, sehingga Dovecot/mailcow internal tetap jalan.

Perintah persis (belum dijalankan):
```
# 0. backup
sudo cp -a /opt/mailcow/data/conf/postfix/master.cf /opt/mailcow/data/conf/postfix/master.cf.bak_$(date +%Y%m%d_%H%M)

# 1. suntik /opt/mailcow/data/conf/postfix/master.cf  (keluaran persis yang diinginkan):

#   blok "smtpd pass" (dipakai postscreen untuk port 25) — tambahkan 1 baris override:
#   smtpd      pass  -       -       n       -       -       smtpd
#     -o smtpd_sender_restrictions=permit_mynetworks,reject_unlisted_sender,reject_unknown_sender_domain
#     -o smtpd_relay_restrictions=permit_sasl_authenticated,defer_unauth_destination      <-- BARU

#   blok "smtps" (465) — ubah client restrictions & tambah relay restrictions:
#   smtps    inet  n       -       n       -       -       smtpd
#     -o smtpd_client_restrictions=permit_sasl_authenticated,reject                       <-- permit_mynetworks DIHAPUS
#     -o smtpd_relay_restrictions=permit_sasl_authenticated,defer_unauth_destination      <-- BARU
#     (…pertahankan opsi lain, termasuk smtpd_tls_security_level)

#   blok "submission" (587) — sama:
#   submission inet n       -       n       -       -       smtpd
#     -o smtpd_client_restrictions=permit_sasl_authenticated,reject                       <-- permit_mynetworks DIHAPUS
#     -o smtpd_relay_restrictions=permit_sasl_authenticated,defer_unauth_destination      <-- BARU
#     -o smtpd_tls_security_level=encrypt

# 2. terapkan TANPA restart container (master.cf dibaca ulang oleh reload)
sudo docker exec mailcow-postfix-mailcow-1 postfix reload

# 3. verifikasi konfigurasi per-port
sudo docker exec mailcow-postfix-mailcow-1 postconf -P "submission/inet"
sudo docker exec mailcow-postfix-mailcow-1 postconf -P "smtps/inet"
sudo docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks     # harus tetap 127.0.0.0/8 172.16.0.0/24
```
Rollback: `sudo cp -a .../master.cf.bak_<tanggal> .../master.cf && sudo docker exec mailcow-postfix-mailcow-1 postfix reload`.

Cara verifikasi sesudah (bukti nyata, bukan asumsi):
1. **Jalur sah tetap jalan** — kirim 1 email uji dari `coder-platform-app` (fitur notifikasi, `SMTP_HOST=mail.ilmupelet.com:587`), lalu:
   `sudo docker logs --since 10m mailcow-postfix-mailcow-1 | grep -E "sasl_username=noreply@coblai.com|status=sent"` → harus ada `sasl_method=LOGIN, sasl_username=noreply@coblai.com` dan `status=sent`.
2. **Jalur tanpa AUTH tertutup** — dari host, tanpa kredensial, lakukan uji relay ke domain luar, mis.:
   `printf 'EHLO uji\r\nMAIL FROM:<noreply@ilmupelet.com>\r\nRCPT TO:<uji@example.com>\r\nQUIT\r\n' | openssl s_client -quiet -starttls smtp -connect mail.ilmupelet.com:587` → harap ditolak `554 5.7.1 Relay access denied` (sebelum perubahan, langkah ini akan lolos).
3. **Port 25 dari dalam/loopback**: `nc -w 3 172.16.0.1 25` → `RCPT TO:<uji@example.com>` harus `Relay access denied`; sedangkan surat masuk ke mailbox lokal (`RCPT TO:<noreply@coblai.com>`) harus tetap OK (relay restrictions tidak mengatur pengantaran lokal).
4. **Forwarding/alias internal mailcow**: kirim surat dari mailbox mailcow ke alamat luar lewat Dovecot/SOGo, cek log tetap ada `postfix/submission/smtpd[...]: client=172.16.0.250[...]` (port 588) dan `status=sent`.

Risiko Opsi C yang **belum bisa dijamin**:
- Ada klien sah (proyek lain/container lain) yang mengirim ke port publik 25/465/587 tanpa AUTH tetapi **tidak muncul** di jendela log 16 hari (volume surat server ini hanya 4 pesan/16 hari). Ini risiko utama. Mitigasi: jalankan pemantauan 7 hari dulu (lihat §7 Opsi 0).
- `master.cf` ada di direktori data mailcow (`/opt/mailcow/data/conf/postfix/`). Pembaruan mailcow dapat mengganti file ini. Mitigasi: periksa ulang dengan `postconf -P "submission/inet"` setiap selesai update mailcow, dan simpan salinan master.cf versi yang sudah dipatch di repo.
- `postfix reload` memuat ulang konfigurasi; koneksi SMTP yang sedang berjalan akan terputus sekejap (biasanya tidak terasa).

### Opsi 0 (pelengkap, sebelum Opsi C) — pemantauan dulu, tanpa mengubah apa pun

```
# jalankan 7 hari di terminal terpisah (tidak mengubah konfigurasi):
sudo docker logs -f --since 0m mailcow-postfix-mailcow-1 | grep --line-buffered -E "smtpd\[[0-9]+\]: [0-9A-F]+: client="
# lalu ringkas:
sudo docker logs --since 168h mailcow-postfix-mailcow-1 | grep -oE "client=[^,]+(, sasl_username=[^,]+)?" | sort | uniq -c | sort -rn | head -20
```
Tujuan: memastikan tidak ada klien `172.16.0.1`/`127.0.0.1` baru yang mengirim **tanpa** `sasl_username` selain aktivitas kita, sebelum mengetatkan port publik.

### Alternatif yang tidak direkomendasikan (dicatat agar tidak dicoba)

- Menghapus `permit_mynetworks` dari `smtpd_relay_restrictions` **global (main.cf)**: akan mematikan relay internal (Dovecot `submission_host = postfix:588`, forwarding/alias keluar memakai `permit_mynetworks`) ⇒ **berisiko merusak mailcow untuk semua pemakai**.
- `mynetworks_style = host`: sama-sama merusak Dovecot (lihat Opsi B).
- Blokir `172.16.0.1/32` atau `127.0.0.0/8` lewat `check_client_access cidr:`: `reject` di `smtpd_client_restrictions` dievaluasi **sebelum** AUTH ditawarkan ⇒ aplikasi kita (yang AUTH dari host) justru ikut terblokir. Tidak dipakai.
- Menutup port 25/465/587 dengan firewall host: port-port itu dibuka oleh `docker-proxy`/aturan DOCKER yang **melewati ufw** (`DOCKER-USER` masih kosong) ⇒ perlu aturan `DOCKER-USER` khusus; tetap tidak membedakan "host" vs "container lain" karena keduanya 172.16.0.1.

---

## 7. Rekomendasi akhir

1. **Pakai Opsi C** (wajib AUTH pada 25/465/587) — menutup lubang relay lintas-tenant, mempertahankan seluruh alur internal mailcow (port 588 dkk. tidak disentuh), dan aplikasi kita tetap jalan karena memang memakai AUTH 587.
2. Jalankan **Opsi 0** 7 hari sebelum Opsi C bila ingin bukti tambahan (murah, tanpa perubahan).
3. **Jangan** pakai Opsi B sendirian: lubang utama (172.16.0.1) tidak tertutup.
4. Perubahan yang memicu restart/relay mailcow adalah **aksi berisiko** ⇒ butuh persetujuan Boss sebelum dijalankan. Recon ini tidak menjalankannya.

---

## 8. Yang belum bisa dijamin (jujur)

1. **Log hanya mencakup 16 hari** (31 Agu – 16 Sep 2026) dan volume surat server sangat kecil (4 pesan diterima). Pemakai relay tanpa autentikasi yang jarang (bulanan/musiman) dapat luput.
2. **Konfigurasi proyek lain tidak seluruhnya diperiksa**: hanya variabel environment container yang dapat dibaca. Proyek yang menyimpan setelan SMTP di database (mis. listmonk, Ghost) atau di dalam aplikasi tidak terverifikasi; perlu dicek satu per satu bila ingin kepastian penuh.
3. **Log mailcow sebelumnya tidak tersedia**: `/var/log/mail.log` di container postfix/dovecot kosong; `docker logs` hanya selama container hidup. Bukti sebelum 31 Agu 2026 hilang.
4. **Perilaku asal-IP `172.16.0.1` disimpulkan dari bukti log + aturan iptables/MASQUERADE** (aplikasi kita ada di `coder-net` 192.168.192.0/20 tetapi tercatat sebagai `172.16.0.1`). Penyebab pastinya (docker-proxy vs DNAT+MASQUERADE) tidak diamati paket-per-paket; tidak ada `tcpdump` karena bersifat read-only.
5. **Efek samping Opsi C tidak diuji langsung** (tidak boleh mengirim surat uji / reload saat recon). Rencana verifikasi ada di §6, tetapi hasil nyata baru bisa dipastikan setelah perubahan dijalankan.
6. **Dampak pada webmail SOGo belum bisa dipastikan**: `sogo.conf` tidak memuat `SOGoSMTPServer`, dan container SOGo tidak punya `sendmail`. Artinya SOGo tidak memakai port publik 25/465/587 (jadi Opsi C tidak menyentuhnya), tetapi apakah pengiriman webmail saat ini berfungsi tidak diperiksa pada recon ini.
7. **Pembaruan mailcow** dapat menimpa `master.cf`; tanpa pemeriksaan ulang setelah tiap update, pengetatan bisa hilang tanpa terasa.

---

## 9. Lampiran — daftar perintah yang dijalankan (semuanya read-only)

```bash
ssh -F /workspace/.ssh/config coder "hostname; whoami; id -u; sudo -n hostname"

sudo -n docker exec mailcow-postfix-mailcow-1 postconf -n | grep -E "mynetworks|smtpd_relay_restrictions|smtpd_client_restrictions|smtpd_sender_restrictions|smtpd_tls_security_level|inet_interfaces"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks_style
sudo -n docker exec mailcow-postfix-mailcow-1 grep -n -E "mynetworks|inet_interfaces" /opt/postfix/conf/main.cf
sudo -n docker exec mailcow-postfix-mailcow-1 grep -nE "^[0-9a-z]|smtpd_client_restrictions|smtpd_relay_restrictions|smtpd_sender_restrictions|smtpd_tls_security_level" /opt/postfix/conf/master.cf
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -n | grep -E "milter|rate_limit|anvil|helo_required|delay_reject"
sudo -n docker exec mailcow-postfix-mailcow-1 sed -E "s/(pass|password|_pw|passwd)[^ ]*=.*/\1=***MASKED***/I" /opt/postfix/conf/extra.cf
sudo -n docker exec mailcow-postfix-mailcow-1 grep -n -B3 -A6 "extra.cf" /opt/postfix.sh   # keluaran disamarkan
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -n | grep -E "inet_interfaces|mynetworks"
sudo -n docker exec mailcow-postfix-mailcow-1 cat /docker-entrypoint.sh

sudo -n docker network ls --format "{{.Name}}|{{.Driver}}|{{.Scope}}"
sudo -n docker network inspect -f '{{.Name}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{range $k,$v := .Containers}}{{$v.Name}},{{end}}' $(sudo -n docker network ls -q)
sudo -n docker inspect mailcow-postfix-mailcow-1 -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} ip={{$v.IPAddress}} gw={{$v.Gateway}}{{"\n"}}{{end}}'
sudo -n docker port mailcow-postfix-mailcow-1
sudo -n docker inspect mailcow-postfix-mailcow-1 -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
ip -4 addr show br-mailcow | grep -E "inet |link/"
sudo -n iptables -t nat -S POSTROUTING
sudo -n iptables -t nat -S DOCKER
sudo -n iptables -S DOCKER-USER
sudo -n ufw status
sudo -n ss -lntp | grep -E ":25 |:465 |:587 "

sudo -n docker logs --timestamps mailcow-postfix-mailcow-1 | head -3
sudo -n docker logs --timestamps mailcow-postfix-mailcow-1 | tail -3
sudo -n docker logs --since 48h mailcow-postfix-mailcow-1 | wc -l
sudo -n docker logs --since 48h mailcow-postfix-mailcow-1 | grep -oE "client=[^,]+" | sort | uniq -c | sort -rn
sudo -n docker logs mailcow-postfix-mailcow-1 | grep -oE "sasl_username=[^,]*" | sort | uniq -c | sort -rn
sudo -n docker logs mailcow-postfix-mailcow-1 | grep -oE "sasl_method=[A-Za-z]*" | sort | uniq -c
sudo -n docker logs --timestamps mailcow-postfix-mailcow-1 | grep -vE "postfix/(dnsblog|postscreen)" > /tmp/dinda_recon_postfix_interesting.log   # lalu dihapus
sudo -n docker logs mailcow-postfix-mailcow-1 | grep -c "NOQUEUE"

# survei nama variabel environment (nilai rahasia disamarkan; hanya container yang punya kunci SMTP/MAIL yang ditampilkan)
for c in $(sudo -n docker ps --format '{{.Names}}'); do sudo -n docker exec "$c" sh -c 'tr "\0" "\n" < /proc/1/environ' | awk -F= 'tolower($1) ~ /(smtp|mail)/' ; done

sudo -n docker exec mailcow-dovecot-mailcow-1 grep -rn -E "submission_host" /etc/dovecot/dovecot.conf
sudo -n docker exec mailcow-sogo-mailcow-1 sed -n '40,75p' /etc/sogo/sogo.conf
sudo -n docker exec mailcow-watchdog-mailcow-1 ls -la /usr/sbin/sendmail
sudo -n cat /opt/mailcow/data/conf/postfix/custom_postscreen_whitelist.cidr
sudo -n grep -E "^MAILCOW_HOSTNAME" /opt/mailcow/mailcow.conf
getent hosts mail.ilmupelet.com ; sudo -n docker exec coder-platform-app getent hosts mail.ilmupelet.com
```

**Status akhir server: tidak berubah.** Tidak ada file konfigurasi yang diedit, tidak ada layanan yang direstart/di-reload, tidak ada kata sandi yang ditampilkan. Berkas sementara `/tmp/dinda_recon_postfix_interesting.log` sudah dihapus.
