#!/bin/bash
# display-diag.sh - one-shot diagnostic for the Argon Industria HMI 10CS (HDMI panel) on a Raspberry Pi 5.
#
# Run ONCE at boot from the SD card's boot partition, the same way Raspberry Pi Imager runs its first-run script:
#   append to /boot/firmware/cmdline.txt (one line):
#     systemd.run=/boot/firmware/display-diag.sh systemd.run_success_action=reboot systemd.run_failure_action=none systemd.unit=kernel-command-line.target
# It writes /boot/firmware/display-diag.txt (readable on any PC: the boot partition is FAT), removes those three
# arguments again, and reboots into the normal system. If it cannot run, the Pi stays at a console (no reboot loop):
# then put the card back in a PC and copy cmdline.txt.before-display-diag over cmdline.txt (if you made that backup).
#
# What it records: each HDMI connector's state as the kernel sees it (connected/disconnected, EDID = the monitor's
# identity, modes), power/throttling, the kernel's HDMI messages, USB devices (the touch panel), input devices.
#
# Fix it applies, only when the answer is unambiguous: boot with the ordinary HDMI monitor AND the 10" panel both
# attached. If exactly one HDMI connector is "connected" (the monitor) and the other "disconnected" (the panel not
# signalling hot-plug), it adds   video=HDMI-A-<n>:1280x800@60D   for the disconnected one to cmdline.txt, which makes
# the kernel drive that output anyway (D = force on). Original saved as cmdline.txt.before-display-fix.
# If both are connected or both disconnected it changes nothing and says so.
BOOT=${DIAG_BOOT:-/boot/firmware}; DRM=${DIAG_DRM:-/sys/class/drm}   # overridable only for the repository's test
OUT=$BOOT/display-diag.txt
CMD=$BOOT/cmdline.txt
exec > "$OUT" 2>&1
echo "== eRIGHT kiosk display diagnostic  $(date -u +%FT%TZ)"
tr -d '\0' < /proc/device-tree/model; echo
uname -r
echo
# The display driver loads during boot; give it up to 30 s to create its connectors.
for i in $(seq 1 30); do ls $DRM/ 2>/dev/null | grep -q 'HDMI-A' && break; sleep 1; done
sleep 3
echo "== HDMI connectors (HDMI-A-1 = the micro-HDMI port next to USB-C power, HDMI-A-2 = the other)"
CONNECTED=(); DISCONNECTED=()
for c in $DRM/card*-HDMI-A-*; do
  [ -e "$c" ] || { echo "no HDMI connectors found in $DRM"; break; }
  name=${c##*-HDMI-A-}; st=$(cat "$c/status" 2>/dev/null); en=$(cat "$c/enabled" 2>/dev/null)
  bytes=$(wc -c < "$c/edid" 2>/dev/null || echo 0)
  echo "-- HDMI-A-$name ($c)"
  echo "   status:  $st"
  echo "   enabled: $en"
  echo "   EDID:    $bytes bytes"
  if [ "${bytes:-0}" -gt 0 ]; then echo "   EDID text: $(tr -c '[:print:]' ' ' < "$c/edid" | tr -s ' ' | cut -c1-120)"; fi
  echo "   modes:   $(head -6 "$c/modes" 2>/dev/null | tr '\n' ' ')"
  if [ "$st" = "connected" ]; then CONNECTED+=("$name"); else DISCONNECTED+=("$name"); fi
done
echo
echo "== power"
vcgencmd get_throttled 2>/dev/null || echo "vcgencmd not available"
vcgencmd pmic_read_adc EXT5V_V 2>/dev/null
echo "(get_throttled 0x0 = no under-voltage seen; bit 0 / bit 16 set = under-voltage now / since boot)"
echo
if command -v kmsprint >/dev/null; then echo "== kmsprint"; kmsprint 2>&1 | head -40; echo; fi
echo "== kernel messages (display, HDMI, power, touch)"
dmesg | grep -iE 'hdmi|vc4|drm|hpd|edid|voltage|touch|ilitek|goodix|egalax|hid-multitouch|input:' | tail -80
echo
echo "== USB devices (the panel's touch controller should be one of these)"
lsusb 2>&1
echo
echo "== input devices"
grep -E '^N: Name' /proc/bus/input/devices 2>/dev/null
echo
echo "== kernel command line this boot"
cat /proc/cmdline
echo

# Undo the one-shot arguments first, so this never runs twice.
cp "$CMD" "$BOOT/cmdline.txt.before-display-fix"
sed -i -e 's| systemd.run=[^ ]*||g' -e 's| systemd.run_success_action=[^ ]*||g' -e 's| systemd.run_failure_action=[^ ]*||g' -e 's| systemd.unit=kernel-command-line.target||g' "$CMD"

echo "== decision"
if grep -q 'video=HDMI-A-' "$CMD"; then
  echo "cmdline.txt already has a video=HDMI-A- setting: not changing it."
elif [ ${#CONNECTED[@]} -eq 1 ] && [ ${#DISCONNECTED[@]} -eq 1 ]; then
  p=${DISCONNECTED[0]}
  sed -i "1 s|\$| video=HDMI-A-$p:1280x800@60D|" "$CMD"
  echo "HDMI-A-${CONNECTED[0]} is connected (the ordinary monitor); HDMI-A-$p reports disconnected."
  echo "Added  video=HDMI-A-$p:1280x800@60D  so the kernel drives HDMI-A-$p anyway (the 10\" panel's port)."
  echo "If the 10\" panel is STILL dark after this reboot, the video signal now reaches it, so check its 5 V power lead"
  echo "(to the PoE+ HAT's 5 V header) and the flat-flex (end no.1 display, no.2 HDMI board, contacts to the white side)."
else
  echo "Connected: ${CONNECTED[*]:-none}   Disconnected: ${DISCONNECTED[*]:-none}"
  echo "Not unambiguous (need exactly one monitor connected and the panel's port disconnected): nothing changed."
fi
echo
echo "== cmdline.txt now"
cat "$CMD"
sync
exit 0
