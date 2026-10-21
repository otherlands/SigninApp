#!/usr/bin/env bash
# install-labels.sh - visitor label printing on the door kiosk Pi: Brother QL-700 (USB) prints a stick-on label for
# every visitor who signs in. Re-runnable. Run as root on the kiosk Pi from a checkout of the repository:
#   sudo bash deploy/kiosk-pi/labels/install-labels.sh
# Options (env): SIGNIN_URL (default http://192.168.101.102:3000), LABEL_LENGTH_MM (endless rolls, default 90)
# The QL-700's green "Editor Lite" light must be OFF (press its button until it goes out): in Editor Lite mode the
# printer shows up as a USB drive instead of a printer.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/eright-labels; ENVF=/etc/eright-labels.env
export DEBIAN_FRONTEND=noninteractive

echo "== 1 python + library =="
python3 -c 'import venv, ensurepip' 2>/dev/null || apt-get install -y -qq python3-venv >/dev/null
dpkg -s fonts-dejavu-core >/dev/null 2>&1 || apt-get install -y -qq fonts-dejavu-core >/dev/null
install -d "$DEST"
[ -x "$DEST/venv/bin/python" ] || python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install -q --disable-pip-version-check 'brother-ql-next==0.12.0' 'pillow>=10'
install -m 0755 "$HERE/label_agent.py" "$DEST/label_agent.py"
echo "  $("$DEST/venv/bin/pip" show brother-ql-next | grep ^Version) (brother-ql-next)"

echo "== 2 user + settings =="
id labels >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin labels
usermod -aG lp labels                     # /dev/usb/lp0 is root:lp 0660
install -d -o labels -g labels -m 0750 /var/lib/eright-labels
if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOF
# eRIGHT visitor labels (deploy/kiosk-pi/labels). Nothing secret: /api/state and /api/stream are the public kiosk view.
SIGNIN_URL=${SIGNIN_URL:-http://192.168.101.102:3000}
LABEL_PRINTER=file:///dev/usb/lp0
LABEL_MODEL=QL-700
# Length of each label on an endless roll (mm). Die-cut rolls are detected and filled automatically.
LABEL_LENGTH_MM=${LABEL_LENGTH_MM:-90}
# Print only visitors who signed in within this many seconds (a restart never prints a backlog).
LABEL_WINDOW_SECONDS=600
# 0 = leave the vehicle registration off the label
LABEL_SHOW_VEHICLE=1
EOF
  echo "  wrote $ENVF"
else echo "  $ENVF present (kept)"; fi

echo "== 3 service =="
cat > /etc/systemd/system/eright-labels.service <<EOF
[Unit]
Description=eRIGHT visitor labels (Brother QL-700)
After=network-online.target
Wants=network-online.target

[Service]
User=labels
Group=labels
SupplementaryGroups=lp
EnvironmentFile=$ENVF
ExecStart=$DEST/venv/bin/python $DEST/label_agent.py run
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/eright-labels
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable eright-labels >/dev/null
systemctl restart eright-labels
sleep 3
echo "  service: $(systemctl is-active eright-labels)"

echo "== 4 printer =="
if [ -e /dev/usb/lp0 ]; then
  sudo -u labels env $(grep -v '^#' "$ENVF" | xargs) "$DEST/venv/bin/python" "$DEST/label_agent.py" status 2>&1 | tail -1
else
  echo "  no printer at /dev/usb/lp0: plug the QL-700 into the Pi's USB (Editor Lite light off). The service waits for it."
fi
cat <<EOF

LABELS INSTALLED. A label prints within a few seconds of each visitor signing in at the door.
 · Test label now:   sudo -u labels env \$(grep -v '^#' $ENVF | xargs) $DEST/venv/bin/python $DEST/label_agent.py test
 · Reprint badge 7:  ... label_agent.py reprint 7         Printer state: ... label_agent.py status
 · Log:              journalctl -u eright-labels -f
EOF
