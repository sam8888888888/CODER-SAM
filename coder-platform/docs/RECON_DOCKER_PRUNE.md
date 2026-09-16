# RECON PEMAKAIAN DISK DOCKER — SERVER AUSTRIA

- Tanggal recon: 16 Sep 2026 (WIB) / server waktu Eropa
- Host: `austria.hostinghemat.com` (akses: `ssh -F /workspace/.ssh/config coder`)
- Mode: **READ-ONLY**. Tidak ada satu pun perintah hapus / prune / restart yang dijalankan.
- Storage driver: **`io.containerd.snapshotter.v1`** (Docker root `=/var/lib/docker`, tetapi layer image disimpan di `/var/lib/containerd`).

## 1. Disk host

| Mount | Ukuran | Terpakai | Bebas | % |
|---|---|---|---|---|
| `/dev/vda3 /` | 503G | 218G | 265G | 46% |
| `/dev/vda2 /boot` | 975M | 202M | 723M | 22% |

Tempat data Docker sebenarnya:

| Path | Ukuran | Isi |
|---|---|---|
| `/var/lib/containerd` | **87G** | `snapshots` 61G + `content/blobs` 27G (1083 snapshot) |
| `/var/lib/docker` | 4.6G | `volumes` 4.2G, `buildkit` 225M, `containers` 190M |
| Total jejak Docker | **~91.6G** | (angka `79.21GB` di `docker system df` adalah ukuran logis, bukan ukuran disk) |

## 2. Ringkasan `sudo -n docker system df -v`

| Bagian | Jumlah | Dipakai | Ukuran logis | Reclaimable |
|---|---|---|---|---|
| Images | 98 (df) / 99 (`image ls -a`) | 61 | 79.21GB | **30.59GB (38%)** |
| Containers | 81 (77 jalan, 4 berhenti) | 77 | 2.027GB | 182.7MB (9%) |
| Local Volumes | 51 | 49 | 4.404GB | **279.5MB (6%)** |
| Build Cache | 87 | 0 | 13.64GB | **220.9MB** |

Catatan penting yang ditemukan:

1. **Reclaimable volume 279.5MB = volume MILIK KITA**: `coder-platform-agent-data` (0 link). Tidak ada volume lain yang 0 link (`myoffice-sessions` = 0B). Jadi `docker volume prune` hanya mengambil volume kita sendiri → **jangan jalankan tanpa izin**.
2. **Build cache 13.64GB menyesatkan**: dari 86 baris cache, **13.39GB berstatus `SHARED=true`** (layer dasar yang sudah menjadi bagian image). Yang benar-benar privat hanya **220.9MB**.
3. `docker system df -v` **melewatkan 1 image** yang ada di `docker image ls -a`: `sha256:516a26a7c14e…` (3.09GB, dangling). Ini memengaruhi estimasi prune.
4. Ukuran per-image **tidak bisa dijumlahkan**: total kolom SIZE = 138.4GB, padahal ukuran logis hanya 79.21GB (banyak layer dasar dipakai bersama).

## 3. Klasifikasi image

Sumber: `docker image ls -a --no-trunc --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}'`, `docker image inspect`, `docker ps/-a --format '{{.Image}}'`, `docker inspect --format '{{.Image}}|{{.State.Status}}'` untuk 81 container.

### 3a. Dangling (`<none>:<none>`) — 5 image, 9.82GB

| Image ID | Size | Unique | Dipakai container? |
|---|---|---|---|
| `64b0ffc1c586` | 3.90GB | 1.89GB | **Berhenti** → `ayana` |
| `516a26a7c14e` | 3.09GB | (tidak ada di `df -v`) | **Tidak dipakai siapa pun** |
| `6ec475e63531` | 1.26GB | 0.94GB | **Jalan** → `ghost-samuniversity-ghost-1`, `ghost-samian-ghost-1` |
| `5a93c470ae82` | 1.11GB | 1.00GB | **Jalan** → `wordpress-ilmupelet-wordpress-1` |
| `2439dcd7d140` | 0.45GB | 0.37GB | **Jalan** → `wordpress-ilmupelet-db-1` |

→ Hanya **`516a26a7c14e`** yang benar-benar bisa dibuang oleh `docker image prune -f`. 5 layer dasarnya dipakai bersama 23–24 image lain; lapisan uniknya ≈ 2.26GB (`pnpm install` 1.21GB + `COPY . .` 1.01GB + `pnpm build` 40.1MB).

### 3b. Milik proyek kita (tag `coder-*`) — 16 image, 41.98GB ukuran logis

| Tag | Size | Unique | Dipakai |
|---|---|---|---|
| `coder-platform-app:0.17.0` | 2.63GB | 1.7MB | **Jalan** (container `coder-platform-app`) |
| `coder-platform-app:0.16.0` … `0.9.3` (14 tag) | 2.63GB masing-masing | 0.4–1.6MB | Tidak dipakai |
| `coder-agent-engine:0.9.4` | 2.53GB | 13.6kB* | **Jalan** |

\* Semua image `coder-platform-app` berbagi layer dasar 2.629GB yang sama dengan `0.17.0`.

### 3c–3e. Rekap

| Kategori | Jumlah image |
|---|---|
| Dipakai container **berjalan** | 59 |
| Dipakai hanya container **berhenti** | 2 |
| **Tidak dipakai siapa pun** | 38 (30.59GB unique) |

Dangling yang dipakai container berjalan/berhenti (4 image, 4.2GB) tidak bisa dibebaskan tanpa menghapus container proyek lain.

## 4. Estimasi tiap tindakan + risiko

| # | Perintah persis | Perkiraan bebas | Risiko / catatan |
|---|---|---|---|
| 1 | `sudo -n docker image prune -f` | **±2.3GB** (maks 3.09GB) | RENDAH. Hanya membuang `516a26a7c14e` (dangling, image lama proyek hermes, tak dipakai). 4 dangling lain (4.2GB) dipertahankan otomatis karena masih dipakai container ayana/ghost/wordpress. |
| 2 | `sudo -n docker builder prune -f` | **±221MB** | RENDAH. Build berikutnya sedikit lebih lambat. |
| 2b | `sudo -n docker builder prune -a -f` | Klaim ±13.64GB, **nyata jauh lebih kecil** (13.39GB shared dengan image yang tetap ada) — realistis ±0.2–1GB | SEDANG. Cache build hilang → build semua proyek melambat; build paralel proyek lain bisa terpengaruh. |
| 3 | `sudo -n docker image rm coder-platform-app:0.16.0 …:0.9.3` (14 tag, sisakan 0.17.0) | **hanya ±14.9MB** | RENDAH. Tidak ada tag lama `coder-agent-engine` (hanya 0.9.4). Rollback ke versi lama jadi tidak mungkin tanpa build ulang. Angka “36.82GB” menyesatkan: layer dasarnya dipakai bersama 0.17.0. |
| 4 | `sudo -n docker image prune -a -f` | **±30.59GB + maks 3.09GB ≈ 33.7GB** | **TINGGI — JANGAN tanpa izin pemilik proyek lain.** Menghapus semua image yang tidak dipakai container, termasuk image proyek lain (lihat tabel di bawah). |
| 5 | `sudo -n docker container prune -f` | 182.7MB | SEDANG. Menghapus 4 container berhenti milik orang lain: `rena`, `nadine`, `ayana` (image `nousresearch/hermes-agent:latest`), `postgres`. Jangan tanpa izin. |
| 6 | `sudo -n docker volume prune -f` | 279.5MB | SEDANG. Hanya volume kita `coder-platform-agent-data` (0 link). **Perlu konfirmasi** apakah masih perlu untuk rollback. |

### Yang akan hilang bila `docker image prune -a -f` dijalankan (BUKAN milik kita)

| Proyek (prefix image) | Jumlah image tak terpakai | Unique (GB) |
|---|---|---|
| `myoffice-myoffice-studio` (4 backup 9–10 Sep) | 4 | 6.61 |
| `nousresearch/hermes-agent:v2026.8.19` | 1 | 5.55 |
| `ideatobook-web` (latest/pre-fix = 1 image, + `20260824-emailverify`) | 2 | 4.35 |
| `hermes-studio` / `hermes-agent` | 2 | 3.63 |
| `516a26a7c14e` (dangling hermes) | 1 | ≤3.09 |
| `ideatocourse-render-service` | 1 | 2.66 |
| `gods-eye-view-gods-eye-view` | 1 | 2.33 |
| `ghost:6` | 1 | 1.95 |
| `wordpress:php8.3-apache` | 1 | 1.49 |
| `postgres:16`, `postgres:18-alpine` | 2 | 1.37 |
| `mariadb:11` | 1 | 0.52 |
| `python`, `axllent/mailpit`, `node`, `alpine`, `ubuntu`, `hello-world` | 21 | 0.13 |
| **`coder` (kita)** | 14 | **0.015** |

Kesimpulan penting: **dari 30.59GB reclaimable, kontribusi kita hanya ±15MB (0.05%)**. Sisa >99% milik proyek lain (myoffice, hermes, ideatobook, ideatocourse, gods-eye-view, ghost, wordpress-ilmupelet, jesse, dll). Image besar lain yang **sedang dipakai** (jadi tidak akan kena prune -a): mailcow (15 image ghcr.io), findbuyer (4 image, 4.82GB), sam-* (5.29GB), salesandmarketing (3.40GB), camofox (3.64GB).

## 5. `/tmp` dan cache paket (aman, bukan bagian Docker)

| Path | Ukuran | Isi terbesar | Pemilik | Saran |
|---|---|---|---|---|
| `/tmp` | 873M | `node-compile-cache` 471M, `ovwheels` 176M, `ovwheels.tar.gz` 174M, `sshtool` 25M, `whvenv` 12M | dinda / rena / nadine | Boleh bersihkan **`/tmp/node-compile-cache` (471M, milik kita)**. Sisanya milik rena/nadine → jangan sentuh. |
| `/root/.npm/_cacache` | 514M | cache npm | root | `sudo -n npm cache clean --force` → bebas ±514M, aman (hanya cache). |
| `/root/.cache` | 46M | `pip` 46M | root | Aman dibersihkan (pip cache) → ±46M. |
| `/var/cache/apt` | 604M | arsip .deb | root | `sudo -n apt-get clean` → bebas ±604M. |
| `/var/log` | 685M | `journal` 555M | root | `sudo -n journalctl --vacuum-size=200M` → bebas ±350M (log lama semua user). |

Total pembersihan non-Docker yang relatif aman: **±2.0GB**.

## 6. Rekomendasi urutan (paling aman dulu)

1. `sudo -n docker image rm coder-platform-app:{0.9.3,0.9.4,0.9.5,0.10.0,0.10.1,0.10.2,0.11.0,0.12.0,0.13.0,0.13.1,0.14.0,0.14.1,0.15.0,0.16.0}` → ±15MB (hanya merapikan; sisakan `0.17.0`).
2. `sudo -n docker builder prune -f` → ±221MB.
3. `sudo -n docker image prune -f` → ±2.3GB.
4. Pembersihan cache host (npm/pip/apt/journal + `/tmp/node-compile-cache`) → ±2.0GB.
5. **Total aman ≈ 4.5GB**, tidak menyentuh proyek lain.
6. `docker image prune -a -f` / `docker container prune` / `docker volume prune` → **tahan dulu**, butuh izin pemilik proyek lain (dan konfirmasi volume `coder-platform-agent-data`).

## 7. Perintah recon yang dipakai (semua read-only)

```
ssh -F /workspace/.ssh/config coder 'sudo -n docker system df -v'
ssh -F /workspace/.ssh/config coder 'sudo -n docker system df'
ssh -F /workspace/.ssh/config coder 'sudo -n docker image ls -a --no-trunc --format ...'
ssh -F /workspace/.ssh/config coder 'sudo -n docker image ls -a --filter dangling=true'
ssh -F /workspace/.ssh/config coder "sudo -n docker ps -a --format '{{.Image}}|{{.ID}}'"
ssh -F /workspace/.ssh/config coder 'sudo -n docker inspect --format ... <81 container id>'
ssh -F /workspace/.ssh/config coder 'sudo -n docker image inspect --format ... <99 image id>'
ssh -F /workspace/.ssh/config coder 'sudo -n docker buildx du'
ssh -F /workspace/.ssh/config coder 'sudo -n du -xsh /var/lib/containerd /var/lib/docker /tmp /var/cache /root/.npm/_cacache /root/.cache'
ssh -F /workspace/.ssh/config coder 'sudo -n journalctl --disk-usage'
```
