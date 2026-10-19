#!/usr/bin/env bash
# upgrade-ct106.sh — pull + test + restart the live sign-in server on CT 106 (keeps /etc/eright-signin.env). Read back health.
# v4.1: 1 snapshot the database (VACUUM INTO, consistent while the server runs)  2 run the installer, which pulls and
# runs the tests as a GATE (failed tests = checkout put back, service untouched)  3 after the restart, wait up to 30 s
# for /api/health to answer ok:true — if it does not, ROLL BACK: previous commit + the pre-upgrade database (a newer
# schema is refused by older code, so the snapshot must go back with it) and restart. Ticks made in the seconds
# between the failed start and the rollback would be lost; the script says so if it rolls back.
set -uo pipefail
DEST=/opt/eright-signin; DB="$DEST/data/signin.sqlite"
health() { curl -s -m 4 http://127.0.0.1:3000/api/health; }
echo "== before: $(health | cut -c1-60)"
PREV=$(sudo -u signin git -C "$DEST" rev-parse HEAD)
BK="/root/signin-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
# VACUUM INTO takes one consistent snapshot (WAL included) while the server keeps running; cp of a live WAL db can tear.
node --disable-warning=ExperimentalWarning -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).prepare("VACUUM INTO ?").run(process.argv[2])' \
  "$DB" "$BK" && echo "== db backed up to $BK (code was ${PREV:0:7})" || { echo "== db snapshot FAILED: not upgrading"; exit 1; }
bash "$DEST/deploy/install-ubuntu-vm.sh" > /tmp/signin-install.log 2>&1
RC=$?
grep -E 'updated|tests:|TESTS FAILED|active|WRITTEN|present|INSTALLED' /tmp/signin-install.log | sed 's/^/  /'
NOW=$(sudo -u signin git -C "$DEST" rev-parse HEAD)
# Decide by whether the code MOVED, not by the installer's exit code: it can fail after the restart (the new version
# not active yet, a health curl timing out) and that is exactly when the rollback below is needed.
if [ "$NOW" = "$PREV" ]; then
  if [ "$RC" -ne 0 ]; then echo "== installer stopped (exit $RC) and the code did not change: still on ${PREV:0:7}. Log: /tmp/signin-install.log"; fi
  # Same code: if the service is somehow down, starting it again is the only sensible thing.
  health | grep -q '"ok":true' || { systemctl restart eright-signin; sleep 3; }
  echo "== after: $(health | cut -c1-80)"; exit "$RC"
fi
[ "$RC" -ne 0 ] && echo "== installer exited $RC after moving the code to ${NOW:0:7}: checking health, rolling back if needed"
# Healthy = answering ok:true AND running the version now checked out (an installer that moved the code but failed
# before the restart leaves the OLD process answering ok:true).
WANT=$(sudo -u signin node -p "require('$DEST/package.json').version")
OK=""
for i in $(seq 1 15); do sleep 2; if health | grep -q "\"ok\":true,\"version\":\"$WANT\""; then OK=1; break; fi; done
if [ -z "$OK" ]; then
  echo "== NEW VERSION DID NOT COME UP HEALTHY — rolling back to ${PREV:0:7} and the pre-upgrade database"
  journalctl -u eright-signin -n 15 --no-pager -o cat | sed 's/^/  /'
  systemctl stop eright-signin
  sudo -u signin git -C "$DEST" reset -q --hard "$PREV"
  cp "$DB" "/root/signin-failed-upgrade-$(date -u +%Y%m%dT%H%M%SZ).sqlite" 2>/dev/null || true
  rm -f "$DB-wal" "$DB-shm"; cp "$BK" "$DB"; chown signin:signin "$DB"
  systemctl start eright-signin; sleep 3
  echo "== rolled back: $(health | cut -c1-80)"
  echo "   Anything recorded between the failed start and now is in the /root/signin-failed-upgrade-*.sqlite copy."
  exit 1
fi
echo "== after: $(health | cut -c1-80)"
curl -s -m 4 http://127.0.0.1:3000/metrics | grep -E '^signin_(info|wifi_enabled|presence_here|probably_left)'
journalctl -u eright-signin -n 6 --no-pager -o cat | grep -E 'presence|listening|warn'