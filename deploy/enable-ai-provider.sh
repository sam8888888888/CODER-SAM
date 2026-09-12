#!/usr/bin/env bash
# Enables a real AI provider for the production app on Austria.
#
# Usage (run on the server, as user dinda):
#   deploy/enable-ai-provider.sh openrouter <model>            # key from OPENROUTER_API_KEY env
#   deploy/enable-ai-provider.sh deepseek   <model>                                   
#   deploy/enable-ai-provider.sh openrouter <model> --from-container ideatobook-web
#
# The key is read without being printed and stored in /home/dinda/coder-app/.env, which the
# app container loads through env_file. The container is then recreated with the new tag.
set -euo pipefail

PROVIDER="${1:-}"; MODEL="${2:-}"; shift 2 || true
FROM_CONTAINER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-container) FROM_CONTAINER="${2:-}"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

case "${PROVIDER}" in
  openrouter) KEY_NAME="OPENROUTER_API_KEY" ;;
  deepseek)   KEY_NAME="DEEPSEEK_API_KEY" ;;
  *) echo "usage: $0 <openrouter|deepseek> <model> [--from-container NAME]" >&2; exit 2 ;;
esac
[[ -z "${MODEL}" ]] && { echo "model is required" >&2; exit 2; }

ENV_FILE="/home/dinda/coder-app/.env"
[[ -f "${ENV_FILE}" ]] || { echo "missing ${ENV_FILE}" >&2; exit 2; }

KEY_VALUE="${!KEY_NAME:-}"
if [[ -z "${KEY_VALUE}" && -n "${FROM_CONTAINER}" ]]; then
  KEY_VALUE="$(sudo -n docker inspect "${FROM_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^${KEY_NAME}=//p")"
fi
[[ -z "${KEY_VALUE}" ]] && { echo "no ${KEY_NAME} found (set it in the environment or pass --from-container)" >&2; exit 1; }

set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    KEY="${key}" VALUE="${value}" perl -i -pe 's/^\Q$ENV{KEY}\E=.*/$ENV{KEY}="$ENV{VALUE}"/' "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

set_key "${KEY_NAME}" "${KEY_VALUE}"
set_key PRIME_AGENT_PROVIDER "${PROVIDER}"
set_key PRIME_AGENT_MODEL "${MODEL}"

LATEST="$(ls -1d /home/dinda/coder-app/releases/v* | sort -V | tail -1)"
cd "${LATEST}/src/coder-platform"
cp "${ENV_FILE}" .env
sudo -n docker compose -f docker-compose.austria.yml up -d --force-recreate coder-platform-app
sleep 4
sudo -n docker inspect coder-platform-app --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^\(PRIME_AGENT_[A-Z_]*\)=.*/\1 is set/p'
curl -fsS http://127.0.0.1:3402/ready; echo
echo "AI_PROVIDER_ENABLED ${PROVIDER} ${MODEL}"
