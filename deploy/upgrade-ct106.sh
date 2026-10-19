#!/usr/bin/env bash
# upgrade-ct106.sh — pull + test + restart the live sign-in server on CT 106 (keeps /etc/eright-signin.env). Read back health.
set -uo pipefail
echo "== before: $(curl -s -m 4 http://127.0.0.1:3000/api/health | cut -c1-60)"
BK="/root/signin-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
# VACUUM INTO takes one consistent snapshot (WAL included) while the server keeps running; cp of a live WAL db can tear.
node --disable-warning=ExperimentalWarning -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).prepare("VACUUM INTO ?").run(process.argv[2])' \
  /opt/eright-signin/data/signin.sqlite "$BK" && echo "== db backed up to $BK"
bash /opt/eright-signin/deploy/install-ubuntu-vm.sh 2>&1 | grep -E 'updated|tests:|active|WRITTEN|present|INSTALLED' | sed 's/^/  /'
sleep 2
echo "== after: $(curl -s -m 4 http://127.0.0.1:3000/api/health | cut -c1-80)"
curl -s -m 4 http://127.0.0.1:3000/metrics | grep -E '^signin_(info|wifi_enabled|presence_here|probably_left)'
journalctl -u eright-signin -n 6 --no-pager -o cat | grep -E 'presence|listening'
