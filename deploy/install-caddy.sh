#!/usr/bin/env bash
# install-caddy.sh — put Caddy in front of the sign-in server for HTTPS (signin.eright.co.uk). Idempotent.
# Read deploy/Caddyfile first: the DNS and port-forward prerequisites are NOT in place as of 2026-10-19, and Caddy
# cannot obtain a certificate until they are. The HTTP :3000 listener stays, so the kiosk and QR codes keep working.
#   sudo bash deploy/install-caddy.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
echo "== 1 caddy =="
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "  $(caddy version)"
echo "== 2 config =="
install -m 0644 "$SRC/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy; systemctl reload caddy
echo "== 3 proof =="
sleep 2
HOST=$(grep -m1 -oE '^[a-z0-9.-]+\.[a-z]+' /etc/caddy/Caddyfile)
echo "  public DNS: $(getent ahosts "$HOST" | head -1 || echo 'does not resolve')"
curl -sk -m 8 -o /dev/null -w "  https://$HOST/api/health -> %{http_code} (000 = no certificate yet: fix DNS/port-forward, then: journalctl -u caddy -n 20)\n" "https://$HOST/api/health" || true
echo "  From the OFFICE the line above should be 200 (full access). From the INTERNET it must be 403: only /fire, /safe,"
echo "  their files, GET /api/fire, /api/me, /api/stream and POST /api/fire/mark (self, with a personal key) come through."
echo "  Check from a phone on mobile data: https://$HOST/admin -> 'Not available from outside the office.'"
echo "NEXT: set PUBLIC_URL=https://$HOST in /etc/eright-signin.env and: systemctl restart eright-signin"
