#!/usr/bin/env bash
# wait-ct106.sh — block until eright-signin is active on the container (≤5 min), then read back.
for i in $(seq 1 60); do systemctl is-active -q eright-signin 2>/dev/null && break; sleep 5; done
echo "service: $(systemctl is-active eright-signin)"
pgrep -af 'install-ubuntu|apt-get|dpkg' | head -n 3
echo "node: $(node --version 2>/dev/null)"
[ -f /etc/eright-signin.env ] && echo "env: present ($(grep -c = /etc/eright-signin.env) keys, mode $(stat -c %a /etc/eright-signin.env))"
curl -s -m 5 http://127.0.0.1:3000/api/health | head -c 300; echo
curl -s -m 5 http://127.0.0.1:3000/metrics | grep -E '^signin_(up|info|on_site_total)'
