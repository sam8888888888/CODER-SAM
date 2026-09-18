#!/usr/bin/env bash
# Membangun paket rilis coder-sam-university-v<versi>.tar.gz dari berkas yang SUDAH di-commit.
#
# Usage: deploy/buat-paket.sh 0.20.0
#        PAKET_KELUARAN=/tmp/uji deploy/buat-paket.sh 0.19.9   # coba dulu tanpa menyentuh deploy/
#
# Isi paket: dua folder tingkat atas (`coder-platform/` dan `coder-dashboard/`) persis seperti
# paket-paket sebelumnya. Ditambah satu hal (butir 32): `deploy/env-sync.sh` dan `deploy/env.keys.txt`
# disalin ke `coder-platform/deploy/` DI DALAM paket, karena `deploy/deploy-austria.sh` memanggil
# skrip itu di server (direktori kerja `${REMOTE_DIR}/src/coder-platform`). Tanpa salinan itu deploy
# berhenti dengan `DEPLOY_ABORTED`.
#
# Sumber berkas adalah `git ls-files`, jadi: (1) node_modules/dist/.env/data lokal tidak pernah ikut,
# (2) paket selalu sama dengan isi commit terakhir.
set -euo pipefail

VERSION="${1:-}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <versi>   contoh: $0 0.20.0" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KELUARAN="${PAKET_KELUARAN:-${ROOT}/deploy}"
PAKET="coder-sam-university-v${VERSION}.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

cd "${ROOT}"
git diff --quiet -- coder-platform coder-dashboard deploy || echo "PERINGATAN: ada perubahan belum di-commit; paket memakai isi commit, bukan berkas kerja" >&2

for sub in coder-platform coder-dashboard; do
  git ls-files -z -- "${sub}" | tar -c --null -T - -f - | tar -x -C "${STAGE}"
done

mkdir -p "${STAGE}/coder-platform/deploy"
cp deploy/env.keys.txt deploy/env-sync.sh "${STAGE}/coder-platform/deploy/"
chmod +x "${STAGE}/coder-platform/deploy/env-sync.sh"

mkdir -p "${KELUARAN}"
tar -czf "${KELUARAN}/${PAKET}" -C "${STAGE}" coder-platform coder-dashboard
( cd "${KELUARAN}" && sha256sum "${PAKET}" > "${PAKET}.sha256" )

# Daftar isi dibaca SEKALI ke variabel: `tar | grep -q` akan mematikan tar (SIGPIPE) dan pipefail
# menganggap pipeline gagal, jadi pemeriksaan lewat pipa bisa berbohong.
DAFTAR="$(tar -tzf "${KELUARAN}/${PAKET}")"
JML="$(printf '%s\n' "${DAFTAR}" | wc -l)"
for wajib in coder-platform/deploy/env-sync.sh coder-platform/deploy/env.keys.txt coder-platform/apps/api/src/server.ts coder-dashboard/index.html; do
  grep -qx "${wajib}" <<<"${DAFTAR}" || { echo "PAKET_GAGAL ${wajib} tidak ada di paket" >&2; exit 1; }
done
if grep -qE '(^|/)node_modules/|(^|/)\.env$|(^|/)data/|/dist/' <<<"${DAFTAR}"; then
  echo "PAKET_GAGAL paket memuat node_modules/.env/data/dist" >&2
  exit 1
fi
echo "PAKET_OK ${KELUARAN}/${PAKET} (${JML} entri, $(du -h "${KELUARAN}/${PAKET}" | cut -f1))"
echo "SHA256 $(cat "${KELUARAN}/${PAKET}.sha256")"
