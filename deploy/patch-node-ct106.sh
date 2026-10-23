#!/usr/bin/env bash
# patch-node-ct106.sh — move CT 106's Node.js to the 21 Oct 2026 security build and restart the sign-in server.
# Why (2026-10-23): Node.js shipped a HIGH security release on 21 Oct 2026 (Brotli decoder RCE CVE-2026-111497,
# TLS hostname-check bypasses CVE-2026-106069/105483, dns.resolve NUL truncation CVE-2026-105482) fixed in
# 22.x/24.x/26.x only. CT 106 was installed from NodeSource setup_22.x on 25 Sep 2026 and read back as v22.23.3
# (deploy/bootstrap-ct106.sh log); the fixed 22.x build is v22.23.4. Record: llm-cluster
# docs/nodejs-exposure-2026-10-23.md (EAI-DOC-051), board row 504.
#
# Run as root ON CT 106. Read-only until the apt-get install line; the service restart is the only other change.
# Nothing here touches the database, the checkout or /etc/eright-signin.env (use deploy/upgrade-ct106.sh for code).
set -uo pipefail
WANT="22.23.4"
health() { curl -s -m 4 http://127.0.0.1:3000/api/health; }
echo "== before: node $(node --version 2>/dev/null || echo none) | health $(health | cut -c1-60)"
if ! grep -rqs "deb.nodesource.com" /etc/apt/sources.list.d/; then
  echo "== NodeSource repo not present - this box was not set up by bootstrap-ct106.sh; stopping (nothing changed)"; exit 1
fi
apt-get update -qq
apt-get install -y -qq nodejs
HAVE=$(node --version | sed 's/^v//')
echo "== installed: node v$HAVE"
# dpkg --compare-versions: 'ge' = installed >= wanted
if ! dpkg --compare-versions "$HAVE" ge "$WANT"; then
  echo "== node v$HAVE is still BELOW v$WANT: NodeSource has not published the fixed build yet, or apt is pinned."
  echo "   Check: apt-cache policy nodejs. The server was NOT restarted (no new binary to pick up)."; exit 2
fi
systemctl restart eright-signin
for i in $(seq 1 15); do sleep 2; if health | grep -q '"ok":true'; then break; fi; done
echo "== after: node $(node --version) | health $(health | cut -c1-80)"
health | grep -q '"ok":true' || { echo "== health NOT ok after restart - journalctl -u eright-signin -n 30"; exit 3; }
echo "== done. Record on the board: CT 106 node $(node --version) $(date -u +%Y-%m-%dT%H:%MZ)"
