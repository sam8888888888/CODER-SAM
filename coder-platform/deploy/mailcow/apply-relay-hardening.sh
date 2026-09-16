#!/bin/bash
set -e
STAMP=$(date +%Y%m%d_%H%M)
CONF=/opt/mailcow/data/conf/postfix
sudo -n cp -a "$CONF/master.cf" "$CONF/master.cf.bak_$STAMP"
sudo -n cp -a "$CONF/master.cf" "/tmp/master.cf.bak_$STAMP"
echo "cadangan: $CONF/master.cf.bak_$STAMP"
sha256sum /tmp/master.cf.new | awk '{print "sha256 baru :", $1}'
sudo -n sha256sum "$CONF/master.cf" | awk '{print "sha256 lama :", $1}'
sudo -n docker exec -i mailcow-postfix-mailcow-1 sh -c 'cat > /opt/postfix/conf/master.cf' < /tmp/master.cf.new
sudo -n sha256sum "$CONF/master.cf" | awk '{print "sha256 tulis:", $1}'
sudo -n docker exec mailcow-postfix-mailcow-1 postfix reload
sleep 3
echo "=== submission/inet (587)"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P submission/inet | grep -E 'client_restrictions|relay_restrictions'
echo "=== smtps/inet (465)"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P smtps/inet | grep -E 'client_restrictions|relay_restrictions'
echo "=== smtpd/pass (25)"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P smtpd/pass | grep -E 'relay_restrictions|sasl_auth'
echo "=== mynetworks (harus tetap)"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks
echo "=== port internal 588 (harus tetap longgar)"
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P 588/inet | grep -E 'client_restrictions|relay_restrictions' || echo "(588 tanpa override khusus)"
echo "STAMP=$STAMP"
