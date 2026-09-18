#!/usr/bin/env bash
# Deploys one version of the COBLAI Coder platform to the Austria server.
#
# Usage: deploy/deploy-austria.sh 0.19.0
#
# Safety rules:
# - The package checksum is verified on the server before extraction.
# - Only the coder-* containers of this platform are touched; other services stay untouched.
# - The image tag inside the compose file is set from the version argument, so a stale tag can never be
#   used by accident (this bug shipped v0.1.1 code once).
# - The script fails loudly when the running container image is not the requested tag.
#
# Wave 9 (item 16, 17, 18) added three gates, in this order:
#   1. (item 18) migration rehearsal: the new code migrates the newest production BACKUP inside a
#      throwaway container before anything live is replaced. A migration that would lose or corrupt
#      data stops the deploy here. The live data volume is not even mounted for that container.
#   2. (item 16) blue-green switch: a second copy of the app (the "green" service, port 3403) is
#      started from the new image; when it reports ready, nginx is pointed at it, the live copy is
#      recreated, and nginx is pointed back. Outside those few seconds nginx always has a ready
#      backend, so a page load does not hit a restarting process.
#   3. (item 17) the queue container is recreated, so background work runs in its own process.
set -euo pipefail

VERSION="${1:-}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <version>  e.g. $0 0.19.0" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="coder-sam-university-v${VERSION}.tar.gz"
SSH_TARGET="${SSH_TARGET:-coder}"
REMOTE_DIR="/home/dinda/coder-app/releases/v${VERSION}"
IMAGE="coder-platform-app:${VERSION}"

cd "${ROOT}"
if [[ ! -f "deploy/${PACKAGE}" ]]; then
  echo "missing deploy/${PACKAGE}; build it first" >&2
  exit 2
fi
( cd deploy && sha256sum "${PACKAGE}" > "${PACKAGE}.sha256" )

scp -q "deploy/${PACKAGE}" "deploy/${PACKAGE}.sha256" "${SSH_TARGET}:${REMOTE_DIR}/"

ssh "${SSH_TARGET}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE_DIR}"
sha256sum -c "${PACKAGE}.sha256"
rm -rf src && mkdir -p src
tar -xzf "${PACKAGE}" -C src

cd src/coder-dashboard
npm ci --silent
npm run build

cd ../coder-platform
npm ci --silent
npm run build:api
rm -rf public && mkdir public
cp -a ../coder-dashboard/dist/. public/

# Secrets live in one persistent file outside the release folders, so a deploy never
# wipes a provider key. Butir 32 (Wave 10): penyelarasan kunci memakai deploy/env-sync.sh
# dengan daftar resmi deploy/env.keys.txt. Skrip itu menambahkan kunci baru beserta nilai
# bawaannya, TIDAK pernah menimpa nilai lama, melaporkan kunci usang (ENV_OBSOLETE_KEYS)
# dan kunci asing (ENV_UNKNOWN_KEYS), serta membuat cadangan bernomor .bak.N sebelum
# berkas diubah. Pratinjau --check dijalankan lebih dulu supaya log deploy memuat daftar
# kunci yang masih hilang (ENV_MISSING).
PERSIST="/home/dinda/coder-app/.env"
if [[ ! -f "\${PERSIST}" ]]; then
  cp .env.austria.example "\${PERSIST}"
fi
# Jalur relatif terhadap direktori kerja remote (${REMOTE_DIR}/src/coder-platform).
# Paket tar memuat deploy/ di dalam coder-platform/, jadi kandidat pertama adalah
# deploy/env-sync.sh; ../deploy/env-sync.sh dipakai bila pengemas menaruh deploy/ di
# samping coder-platform. Bila tidak ada, deploy berhenti (jangan diam-diam melewatkan).
ENV_SYNC_SCRIPT=""
ENV_KEYS_FILE=""
for candidate in "deploy/env-sync.sh" "../deploy/env-sync.sh"; do
  if [[ -f "\${candidate}" && -f "\${candidate%/*}/env.keys.txt" ]]; then
    ENV_SYNC_SCRIPT="\${candidate}"
    ENV_KEYS_FILE="\${candidate%/*}/env.keys.txt"
    break
  fi
done
if [[ -z "\${ENV_SYNC_SCRIPT}" ]]; then
  echo "DEPLOY_ABORTED deploy/env-sync.sh + deploy/env.keys.txt tidak ada di paket (butir 32)" >&2
  exit 1
fi
echo "ENV_SYNC_SCRIPT \${ENV_SYNC_SCRIPT} (daftar kunci: \${ENV_KEYS_FILE})"
bash "\${ENV_SYNC_SCRIPT}" "\${PERSIST}" --check --keys-file "\${ENV_KEYS_FILE}"
bash "\${ENV_SYNC_SCRIPT}" "\${PERSIST}" --keys-file "\${ENV_KEYS_FILE}"
# The running version is reported by the app itself, so the value is refreshed on every deploy.
if grep -q "^APP_VERSION=" "\${PERSIST}"; then
  sed -i "s#^APP_VERSION=.*#APP_VERSION=${VERSION}#" "\${PERSIST}"
else
  printf 'APP_VERSION=%s\n' "${VERSION}" >> "\${PERSIST}"
fi
cp "\${PERSIST}" .env

# Any version number in the image tag is replaced by the version being deployed.
sed -Ei "s#(image: coder-platform-app:)[0-9][0-9.]*#\1${VERSION}#" docker-compose.austria.yml
grep -q "image: ${IMAGE}$" docker-compose.austria.yml

cd ..
sudo -n docker build -f coder-platform/Dockerfile.austria -t "${IMAGE}" .
cd coder-platform

COMPOSE="docker-compose.austria.yml"
NGINX_CONF="/etc/nginx/sites-available/coder.sam.university.conf"

# ---------------------------------------------------------------- item 18: migration rehearsal
# The newest application backup is migrated by the NEW image. Nothing live is opened: the data volume
# is not mounted, and the rehearsal copies the file into the container's own temporary folder.
echo "MIGRATION_REHEARSAL_START image=${IMAGE}"
LATEST_BACKUP="\$(sudo -n docker run --rm --entrypoint node -v coder-platform-backups:/app/backups:ro "${IMAGE}" \
  -e 'const fs=require("fs");const d="/app/backups";try{const f=fs.readdirSync(d).filter(n=>n.endsWith(".db")).map(n=>d+"/"+n).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);console.log(f[0]||"")}catch(e){console.log("")}')"
if [[ -z "\${LATEST_BACKUP}" ]]; then
  echo "MIGRATION_REHEARSAL_SKIPPED tidak ada cadangan .db di volume coder-platform-backups" >&2
else
  echo "MIGRATION_REHEARSAL_BACKUP \${LATEST_BACKUP}"
  sudo -n docker run --rm --entrypoint node -v coder-platform-backups:/app/backups:ro "${IMAGE}" \
    /app/dist/api/migration-rehearsal.js "\${LATEST_BACKUP}" > /tmp/migration-rehearsal.log 2>&1 || {
      tail -20 /tmp/migration-rehearsal.log >&2
      echo "DEPLOY_ABORTED migrasi gagal di atas cadangan produksi" >&2
      exit 1
    }
  grep -q "MIGRATION_REHEARSAL_OK" /tmp/migration-rehearsal.log || {
    tail -20 /tmp/migration-rehearsal.log >&2
    echo "DEPLOY_ABORTED hasil rehearsal tidak jelas" >&2
    exit 1
  }
  grep -E "SCHEMA_VERSION_AFTER_MIGRATION|ROW_COUNTS_PRESERVED|MIGRATION_REHEARSAL_OK" /tmp/migration-rehearsal.log | sed 's/^/REHEARSAL /'
fi

# ---------------------------------------------------------------- helpers for the blue-green switch
point_nginx() {   # \$1 = port the live traffic must go to
  local port="\$1"
  sudo -n cp -a "\${NGINX_CONF}" "\${NGINX_CONF}.last-deploy"
  sudo -n sed -i -E "s#proxy_pass http://127.0.0.1:[0-9]+;#proxy_pass http://127.0.0.1:\${port};#" "\${NGINX_CONF}"
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  echo "NGINX_POINTED \${port} (\$(grep -m1 -o 'proxy_pass http://127.0.0.1:[0-9]*' "\${NGINX_CONF}"))"
}

wait_ready() {    # \$1 = port, \$2 = seconds to wait
  local port="\$1" tries="\${2:-90}" i=0
  while (( i < tries )); do
    if curl -fsS --max-time 3 "http://127.0.0.1:\${port}/ready" >/dev/null 2>&1; then
      echo "READY \${port} setelah \${i}s"
      return 0
    fi
    sleep 1
    i=\$(( i + 1 ))
  done
  return 1
}

# ---------------------------------------------------------------- item 16: zero-downtime switch
if [[ -f "\${NGINX_CONF}" ]] && grep -q "proxy_pass http://127.0.0.1:34" "\${NGINX_CONF}"; then
  echo "ZERO_DOWNTIME_START hijau di 3403"
  sudo -n docker compose -f "\${COMPOSE}" --profile green up -d coder-platform-app-green
  if wait_ready 3403 120; then
    point_nginx 3403
    # Blue is recreated while green serves every request.
    sudo -n docker compose -f "\${COMPOSE}" up -d --force-recreate coder-platform-app
    if wait_ready 3402 120; then
      point_nginx 3402
    else
      echo "DEPLOY_BLOCKED biru tidak siap; trafik masih dilayani hijau di 3403" >&2
      exit 1
    fi
  else
    sudo -n docker logs --tail 20 coder-platform-app-green >&2 || true
    echo "DEPLOY_BLOCKED hijau tidak siap; trafik tetap di biru 3402" >&2
    exit 1
  fi
  sudo -n docker compose -f "\${COMPOSE}" --profile green stop coder-platform-app-green
  echo "ZERO_DOWNTIME_DONE hijau dihentikan, biru melayani 3402"
else
  echo "ZERO_DOWNTIME_SKIPPED \${NGINX_CONF} tidak memuat proxy_pass ke 127.0.0.1:34xx; memakai recreate biasa" >&2
  sudo -n docker compose -f "\${COMPOSE}" up -d --force-recreate coder-platform-app
fi

# ---------------------------------------------------------------- item 17: the queue container
sudo -n docker compose -f "\${COMPOSE}" up -d --force-recreate coder-platform-worker
sleep 5
sudo -n docker logs --tail 6 coder-platform-worker 2>&1 | sed 's/^/WORKER_LOG /'

sleep 2
RUNNING="\$(sudo -n docker inspect coder-platform-app --format '{{.Config.Image}}')"
if [[ "\${RUNNING}" != "${IMAGE}" ]]; then
  echo "DEPLOY_IMAGE_MISMATCH expected ${IMAGE} got \${RUNNING}" >&2
  exit 1
fi
curl -fsS http://127.0.0.1:3402/ready
echo
echo "DEPLOY_OK ${IMAGE}"
REMOTE
