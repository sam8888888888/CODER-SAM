#!/bin/bash
# ROLLBACK pengetatan relay mailcow (butir 14). Jalankan di server Austria.
# Pakai berkas cadangan yang dibuat saat patch, lalu muat ulang Postfix (tanpa restart container).
set -e
STAMP="${1:?pakai: bash rollback-relay-hardening.sh <STAMP, mis. 20260916_1516>}"
CONF=/opt/mailcow/data/conf/postfix
sudo -n cp -a "$CONF/master.cf.bak_$STAMP" "$CONF/master.cf"
sudo -n docker exec mailcow-postfix-mailcow-1 postfix reload
sleep 2
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P submission/inet | grep relay_restrictions
echo "ROLLBACK_SELESAI"
