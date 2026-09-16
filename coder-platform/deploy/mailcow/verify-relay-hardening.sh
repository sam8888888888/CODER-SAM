#!/bin/bash
# Verifikasi bahwa pengetatan relay mailcow masih terpasang (mis. sesudah pembaruan mailcow).
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P submission/inet | grep -E 'client_restrictions|relay_restrictions'
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P smtps/inet | grep -E 'client_restrictions|relay_restrictions'
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -P smtpd/pass | grep -E 'relay_restrictions'
sudo -n docker exec mailcow-postfix-mailcow-1 postconf -h mynetworks
