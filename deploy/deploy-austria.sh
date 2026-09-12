#!/usr/bin/env bash
# Deploys one version of the COBLAI Coder platform to the Austria server.
#
# Usage: deploy/deploy-austria.sh 0.6.0
#
# Safety rules:
# - The package checksum is verified on the server before extraction.
# - Only the coder-platform-app container is recreated; other services stay untouched.
# - The image tag inside the compose file is set from the version argument, so a stale
#   tag can never be used by accident (this bug shipped v0.1.1 code once).
# - The script fails loudly when the running container image is not the requested tag.
set -euo pipefail

VERSION="${1:-}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <version>  e.g. $0 0.6.0" >&2
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
sha256sum "deploy/${PACKAGE}" > "deploy/${PACKAGE}.sha256"

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
cp .env.austria.example .env

# Any version number in the image tag is replaced by the version being deployed.
sed -Ei "s#(image: coder-platform-app:)[0-9][0-9.]*#\1${VERSION}#" docker-compose.austria.yml
grep -q "image: ${IMAGE}$" docker-compose.austria.yml

cd ..
sudo -n docker build -f coder-platform/Dockerfile.austria -t "${IMAGE}" .
cd coder-platform
sudo -n docker compose -f docker-compose.austria.yml up -d --force-recreate coder-platform-app

sleep 4
RUNNING="\$(sudo -n docker inspect coder-platform-app --format '{{.Config.Image}}')"
if [[ "\${RUNNING}" != "${IMAGE}" ]]; then
  echo "DEPLOY_IMAGE_MISMATCH expected ${IMAGE} got \${RUNNING}" >&2
  exit 1
fi
curl -fsS http://127.0.0.1:3402/ready
echo
echo "DEPLOY_OK ${IMAGE}"
REMOTE
