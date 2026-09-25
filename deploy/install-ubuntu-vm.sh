#!/usr/bin/env bash
# install-ubuntu-vm.sh — put eRIGHT Sign-In on a fresh Ubuntu VM (the recommended home: a small VM on the
# Proxmox node, NOT platform-a — see README "Where to run it"). Idempotent; re-run after `git pull` to update.
#
#   sudo REPO_URL=https://github.com/otherlands/SigninApp.git bash deploy/install-ubuntu-vm.sh
#   (or run it from an already-cloned checkout: sudo bash deploy/install-ubuntu-vm.sh)
#
# What it does: 1 checks Node >= 22.13  2 creates the `signin` user + /opt/eright-signin (clone or update)
#               3 writes /etc/eright-signin.env once with GENERATED ADMIN_PIN + API_TOKEN (printed ONCE, never again)
#               4 installs + enables eright-signin.service  5 proves /metrics answers  6 prints the address for
#               the estate's Prometheus (SIGNIN_ADDR) and the SP_*/TEAMS_* lines still to fill in by hand.
# It does NOT touch the firewall or DHCP: give this VM a reservation in UniFi so its address stays true.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
REPO_URL="${REPO_URL:-}"; DEST=/opt/eright-signin; ENVF=/etc/eright-signin.env; PORT="${PORT:-3000}"

echo "== 1 node =="
if ! command -v node >/dev/null; then
  echo "  node not found. Ubuntu's apt 'nodejs' is often too old; install Node 22 LTS first, e.g. from NodeSource"
  echo "  (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs) then re-run."; exit 1; fi
NV=$(node -p 'process.versions.node'); NMAJ=${NV%%.*}; NMIN=$(echo "$NV" | cut -d. -f2)
if [ "$NMAJ" -lt 22 ] || { [ "$NMAJ" -eq 22 ] && [ "$NMIN" -lt 13 ]; }; then echo "  node $NV is too old: need >= 22.13 (node:sqlite). Abort."; exit 1; fi
echo "  node $NV ok"

echo "== 2 user + checkout =="
id signin >/dev/null 2>&1 || useradd --system --home-dir "$DEST" --shell /usr/sbin/nologin signin
if [ -d "$DEST/.git" ]; then
  # run git as the owner: root pulling a signin-owned checkout trips git's "dubious ownership" refusal
  sudo -u signin git -C "$DEST" pull --ff-only -q && echo "  updated $(git -C "$DEST" rev-parse --short HEAD)"
elif [ -n "$REPO_URL" ]; then
  git clone -q "$REPO_URL" "$DEST" && echo "  cloned $(git -C "$DEST" rev-parse --short HEAD)"
else
  SRC=$(cd "$(dirname "$0")/.." && pwd)
  [ -f "$SRC/server.js" ] || { echo "  no checkout at $DEST and no REPO_URL — run from the repo or set REPO_URL"; exit 1; }
  mkdir -p "$DEST"; cp -a "$SRC/." "$DEST/"; echo "  copied from $SRC"
fi
install -d -o signin -g signin -m 0750 "$DEST/data"
chown -R signin:signin "$DEST"
git config --global --add safe.directory "$DEST" 2>/dev/null || true
(cd "$DEST" && sudo -u signin node --disable-warning=ExperimentalWarning --test 'test/**/*.test.js' 2>&1 | grep -E '^# (pass|fail)' | sed 's/^/  tests: /')

echo "== 3 env file =="
if [ ! -f "$ENVF" ]; then
  # no pipes here: under `set -o pipefail` a `tr </dev/urandom | head -c N` dies of SIGPIPE (hit 2026-09-25 on CT 106)
  PIN=$(printf '%06d' "$(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 ))"); TOK=$(openssl rand -hex 16)
  cat > "$ENVF" <<EOF
# eRIGHT Sign-In — secrets + wiring. chmod 600. Written by deploy/install-ubuntu-vm.sh $(date -u +%FT%TZ)
ADMIN_PIN=$PIN
API_TOKEN=$TOK
TZ_NAME=Europe/London
# The address staff phones use (gives Teams cards an "Open the roll call" button). Set once the VM has a reservation.
PUBLIC_URL=http://$(hostname -I | awk '{print $1}'):$PORT
# Teams Workflows webhook: Teams channel -> Workflows -> "Post to a channel when a webhook request is received" -> paste URL here.
TEAMS_WEBHOOK_URL=
# SharePoint off-site copy (README "SharePoint off-site copy"). All of tenant/client/secret/site needed to switch on.
SP_TENANT_ID=
SP_CLIENT_ID=
SP_CLIENT_SECRET=
SP_SITE=
SP_DRIVE=
SP_FOLDER=eRIGHT Ltd/Sign-in
EOF
  chmod 600 "$ENVF"
  echo "  WRITTEN $ENVF — the generated ADMIN_PIN is $PIN and API_TOKEN is $TOK. Record them now; they are not printed again."
else echo "  $ENVF present (kept)"; fi

echo "== 4 service =="
install -m 0644 "$DEST/deploy/eright-signin.service" /etc/systemd/system/eright-signin.service
systemctl daemon-reload
systemctl enable --now eright-signin >/dev/null
systemctl restart eright-signin
sleep 2; systemctl is-active eright-signin

echo "== 5 proof =="
IP=$(hostname -I | awk '{print $1}')
curl -s -m 5 "http://127.0.0.1:$PORT/api/health" | head -c 200; echo
curl -s -m 5 "http://127.0.0.1:$PORT/metrics" | grep -E '^signin_(up|info)' | sed 's/^/  /'
cat <<EOF

INSTALLED. Pages: kiosk http://$IP:$PORT/   fire http://$IP:$PORT/fire   admin http://$IP:$PORT/admin
NEXT (your hands):
 1. UniFi: DHCP reservation for this VM so $IP stays true; then on platform-a:
      SIGNIN_ADDR=$IP bash ~/llm-cluster/scripts/deploy-signin-monitoring.sh
 2. Teams: create the Workflows webhook on the ops channel, put the URL in $ENVF (TEAMS_WEBHOOK_URL), systemctl restart eright-signin,
    press START ROLL CALL on /fire and watch the card land in seconds; END and watch the summary.
 3. SharePoint: fill the SP_* lines (README), restart, check Admin -> Off-site copies.
 4. Optional belt-and-braces: a REPLICA=1 mirror on platform-a (README "Where to run it").
EOF
