#!/usr/bin/env bash
# Sets a password for one COBLAI Coder account on the Austria server.
# Usage: /home/dinda/coder-app/reset-password.sh <email> "<new password>"
# The helper runs inside the production container and uses the application's own scrypt hashing.
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: $0 <email> \"<new password>\"" >&2; exit 2; fi
HELPER=/home/dinda/coder-app/ops-set-password.cjs
sudo -n docker cp "$HELPER" coder-platform-app:/app/ops-set-password.cjs >/dev/null
sudo -n docker exec -w /app coder-platform-app node ops-set-password.cjs "$1" "$2"
