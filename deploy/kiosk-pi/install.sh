#!/usr/bin/env bash
# install.sh — turn a Raspberry Pi (Raspberry Pi OS Lite or Desktop, Bookworm or newer, 64-bit) into the eRIGHT
# door kiosk: Chromium full-screen on the sign-in page inside `cage` (a tiny Wayland kiosk compositor), no desktop,
# no battery, PoE-powered, restarts itself, screen never blanks. Re-runnable.
#
#   sudo KIOSK_URL=http://192.168.101.102:3000 bash install.sh
#   sudo KIOSK_URL=http://192.168.101.102:3000 KIOSK_CARD_TOKEN='<API_TOKEN from the server env>' bash install.sh
#
# Options (env):  KIOSK_URL        the sign-in server (default http://192.168.101.102:3000)
#                 KIOSK_CARD_TOKEN API_TOKEN so the USB-203 card reader on the Pi is accepted (handed to the page ONCE
#                                  as ?cardToken=, stored in the browser, stripped from the URL; lives in the unit file, root-only)
#                 KIOSK_DEVICE     device name in the event log (default door-kiosk)
#                 KIOSK_SSH_KEY    an ssh public key to add for the `pi`/admin user you are running as (optional)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
URL="${KIOSK_URL:-http://192.168.101.102:3000}"; URL="${URL%/}"
DEV="${KIOSK_DEVICE:-door-kiosk}"
TOK="${KIOSK_CARD_TOKEN:-}"
export DEBIAN_FRONTEND=noninteractive

echo "== 0 preflight: $URL =="
HEALTH=$(curl -s -m 6 "$URL/api/health" || true)
case "$HEALTH" in *'"ok":true'*) echo "  server ok" ;; *) echo "  the sign-in server did not answer at $URL/api/health — check the address / network first"; exit 1 ;; esac

echo "== 1 packages =="
apt-get update -qq
apt-get install -y -qq cage seatd fonts-noto-color-emoji prometheus-node-exporter unattended-upgrades >/dev/null
if apt-cache show chromium >/dev/null 2>&1; then CHROME_PKG=chromium; else CHROME_PKG=chromium-browser; fi
apt-get install -y -qq "$CHROME_PKG" >/dev/null
CHROME=$(command -v chromium || command -v chromium-browser)
echo "  cage $(dpkg-query -W -f='${Version}' cage 2>/dev/null) · $CHROME $(dpkg-query -W -f='${Version}' "$CHROME_PKG" 2>/dev/null | cut -c1-12)"

echo "== 2 kiosk user =="
id kiosk >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin kiosk
usermod -aG video,render,input,tty kiosk
systemctl enable --now seatd >/dev/null 2>&1 || true
# no login prompt on the screen the kiosk owns
systemctl disable --now getty@tty1.service >/dev/null 2>&1 || true

echo "== 3 kiosk unit =="
START="$URL/?device=$DEV"; [ -n "$TOK" ] && START="$START&cardToken=$TOK"
cat > /etc/systemd/system/signin-kiosk.service <<EOF
# eRIGHT door kiosk — Chromium full-screen on the sign-in page inside cage. Installed by deploy/kiosk-pi/install.sh $(date -u +%FT%TZ)
[Unit]
Description=eRIGHT sign-in door kiosk (cage + chromium)
After=network-online.target seatd.service systemd-user-sessions.service
Wants=network-online.target
Conflicts=getty@tty1.service

[Service]
User=kiosk
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
Environment=WLR_LIBINPUT_NO_DEVICES=1
Environment=XDG_SESSION_TYPE=wayland
# cage exits when chromium exits; Restart=always brings the page back in seconds
ExecStart=/usr/bin/cage -- $CHROME --kiosk --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland \\
  --touch-events=enabled --overscroll-history-navigation=0 --disable-pinch --disable-translate --disable-session-crashed-bubble \\
  --check-for-update-interval=31536000 --autoplay-policy=no-user-gesture-required --start-fullscreen "$START"
Restart=always
RestartSec=3
# root-only: the URL may carry the card-reader token
UMask=0077

[Install]
WantedBy=graphical.target
EOF
chmod 0600 /etc/systemd/system/signin-kiosk.service
systemctl daemon-reload
systemctl set-default graphical.target >/dev/null 2>&1 || true
systemctl enable signin-kiosk >/dev/null
systemctl restart signin-kiosk
echo "  unit installed (mode 0600), $( [ -n "$TOK" ] && echo 'card token handed in' || echo 'no card token — USB reader will be refused until KIOSK_CARD_TOKEN is given')"

echo "== 4 screen never blanks =="
CMD=/boot/firmware/cmdline.txt; [ -f "$CMD" ] || CMD=/boot/cmdline.txt
if ! grep -q 'consoleblank=0' "$CMD"; then cp -a "$CMD" "$CMD.bak-$(date -u +%Y%m%dT%H%M%SZ)"; sed -i '1 s/$/ consoleblank=0/' "$CMD"; echo "  consoleblank=0 added (takes effect after reboot)"; else echo "  already set"; fi

echo "== 5 metrics + updates =="
systemctl enable --now prometheus-node-exporter >/dev/null 2>&1 && echo "  node_exporter on :9100 (add this Pi to prometheus.yml job 'node' or a 'signin_kiosk' job)"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
if [ -n "${KIOSK_SSH_KEY:-}" ] && [ -n "${SUDO_USER:-}" ]; then
  H=$(getent passwd "$SUDO_USER" | cut -d: -f6); install -d -m 0700 -o "$SUDO_USER" "$H/.ssh"
  grep -qF "$KIOSK_SSH_KEY" "$H/.ssh/authorized_keys" 2>/dev/null || { echo "$KIOSK_SSH_KEY" >> "$H/.ssh/authorized_keys"; chown "$SUDO_USER" "$H/.ssh/authorized_keys"; chmod 0600 "$H/.ssh/authorized_keys"; }
  echo "  ssh key added for $SUDO_USER"
fi

echo "== 6 proof =="
sleep 6
systemctl is-active signin-kiosk
journalctl -u signin-kiosk -n 5 --no-pager -o cat | cut -c1-160
IP=$(hostname -I | awk '{print $1}')
cat <<EOF

KIOSK INSTALLED. The screen should now show the sign-in page. Address of this Pi: $IP
 · Rotate to portrait (Touch Display 2 on the DSI port): add  video=DSI-1:panel_orientation=right_up  to $CMD and reboot
   (Raspberry Pi docs: "Display rotation" — check the exact token for your OS release).
 · Card reader: plug the USB-203 into the Pi; present an un-enrolled card → page says "Card … is not assigned to anyone".
 · Logs: journalctl -u signin-kiosk -f      Restart page: sudo systemctl restart signin-kiosk
 · Re-run this script any time (idempotent). A reboot is needed once for consoleblank=0.
EOF
