#!/bin/sh
# Prime Agent Hub entrypoint — global node_modules durable di volume prime-runtime
set -e
G=/usr/local/lib/node_modules
if [ ! -d "$G" ]; then mkdir -p "$G"; fi
for d in prime-agent npm corepack; do
  if [ ! -e "$G/$d/package.json" ]; then
    echo "[entrypoint] restore $d dari baked image..."
    cp -a /opt/prime-agent-baked/$d "$G/$d"
  fi
done
echo "[entrypoint] prime-agent v$(node -p "require('$G/prime-agent/package.json').version")"
exec node /app/backend/server.js
