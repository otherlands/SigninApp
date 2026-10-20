#!/bin/bash
# kiosk-prep.sh - one-shot preparation of the front-door kiosk Pi from its SD card (no password needed).
#
# Armed from a PC by copying this file and a PUBLIC key file (admin-pc.pub) to the SD card's boot partition and
# appending to cmdline.txt (one line):
#   systemd.run=/boot/firmware/kiosk-prep.sh systemd.run_success_action=reboot systemd.run_failure_action=none systemd.unit=kernel-command-line.target
# It: 1 adds the public key(s) in admin-pc.pub to root's authorized_keys (only a public key: nothing secret is on the
#     card), 2 records the USB / input / touch state to kiosk-prep.txt (readable on any PC), 3 removes its own
#     cmdline.txt arguments and reboots. If it cannot run, the Pi stays at a console (no reboot loop).
BOOT=${PREP_BOOT:-/boot/firmware}; ROOTHOME=${PREP_HOME:-/root}   # overridable only for the repository's test
OUT=$BOOT/kiosk-prep.txt; CMD=$BOOT/cmdline.txt
exec > "$OUT" 2>&1
echo "== eRIGHT kiosk prep  $(date -u +%FT%TZ)"
echo "== 1 admin key"
if [ -s "$BOOT/admin-pc.pub" ]; then
  install -d -m 700 "$ROOTHOME/.ssh"; touch "$ROOTHOME/.ssh/authorized_keys"; chmod 600 "$ROOTHOME/.ssh/authorized_keys"
  while read -r line; do
    case "$line" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) continue ;; esac
    body=$(echo "$line" | awk '{print $2}')
    if grep -qF "$body" "$ROOTHOME/.ssh/authorized_keys"; then echo "   already present: $(echo "$line" | awk '{print $1, $3}')"
    else echo "$line" >> "$ROOTHOME/.ssh/authorized_keys"; echo "   added: $(echo "$line" | awk '{print $1, $3}')"; fi
  done < "$BOOT/admin-pc.pub"
  rm -f "$BOOT/admin-pc.pub"
else echo "   no admin-pc.pub on the card: nothing added"; fi
echo
echo "== 2 USB / input / touch (after 20 s for USB to settle)"
sleep 20
lsusb 2>&1
grep -E '^N: Name' /proc/bus/input/devices 2>/dev/null
dmesg | grep -iE 'dwc2|touch|multitouch|ilitek|goodix|egalax|hid|usb [0-9-]+: new' | tail -40
echo
cp "$CMD" "$BOOT/cmdline.txt.before-kiosk-prep"
sed -i -e 's| systemd.run=[^ ]*||g' -e 's| systemd.run_success_action=[^ ]*||g' -e 's| systemd.run_failure_action=[^ ]*||g' -e 's| systemd.unit=kernel-command-line.target||g' "$CMD"
echo "== cmdline.txt now"; cat "$CMD"; echo
sync
exit 0
