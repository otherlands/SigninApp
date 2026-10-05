# BENCH CARD — eRIGHT front-door kiosk (Pi 5 + Argon Industria HMI 10CS)

**Print this. Tick as you go. One screwdriver, one Ethernet cable, one PC on the office LAN.**
State on 2026-10-05 from the 09-30 bench session + `deploy/kiosk-pi/install.sh` + README (tip `bbda11e`).
Nothing in the software half has run on real hardware yet — **this build is the evidence**.

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │  TARGET:  wall kiosk, PoE-powered, no battery, shows the sign-in page 24/7   │
 │  SERVER:  http://192.168.101.102:3000   (CT 106 "signin", v3.6, LIVE)        │
 │  HOST:    door-kiosk        USER ON PI: <you set it>      TOKEN: API_TOKEN   │
 └─────────────────────────────────────────────────────────────────────────────┘
```

## 0 · On the bench before you start

| Have | Where it is |
| --- | --- |
| Pi 5 2 GB **with THRML cooler fitted, fan in the FAN header (top-right)** | done 30 Sep |
| Argon PoE+ HAT **seated on the GPIO header, not yet screwed** | done 30 Sep |
| HMI-HDMI interface board **mated to the Pi's edge** (micro-HDMI ×2 + USB-C; it uses NO GPIO) | done 30 Sep |
| HMI 10CS display + aluminium enclosure, flat-flex, 3-pin screen power lead, fixings bag | in the box |
| **"CPE" silicon pad — LEAVE OUT.** It is for the passive cooling column, which cannot fit alongside a HAT | in the box |
| 32 GB micro-SD (ships with RPi OS **Desktop** pre-installed) | in the box |
| USB keyboard + mouse (first boot only), USB-203 card reader, Cat 6 to a **PoE port on the Corporate network** | office |
| PC with `ssh` and the server's `API_TOKEN` (`ssh root@192.168.101.102 grep API_TOKEN /etc/eright-signin.env`) | your desk |

## 1 · Finish the hardware  (≈ 15 min)

- [ ] **Screen power**: 3-pin lead from the HMI board → the PoE+ HAT's **5 V aux header** (Argon's guide: wiki.argon40.com → Industria HMI). Key the plug — it only fits one way.
- [ ] **Flat-flex**: end marked **no.2 → HMI-HDMI board**, end **no.1 → display**. **Contacts face the white side** of each connector. Lift the latch, push home square, close the latch, tug-test gently.
- [ ] **Screw the HAT down** (standoffs from the HAT bag) now that nothing else needs the header.
- [ ] **Close the Pi into the enclosure** — the IO edge (Ethernet + USB) faces where the cable will run. Fixings from the bag; do not over-torque into aluminium.
- [ ] **STOP check**: nothing trapped under the lid, fan spins freely, flat-flex not pinched, SD slot reachable.

## 2 · First boot — the SD has Desktop on it and there is no card reader on the PC  (≈ 10 min)

- [ ] Insert the SD. Plug keyboard + mouse into the edge USB. **Plug the Cat 6 from a PoE port** — the Pi powers up (rainbow → text → desktop). No PoE? The HAT's LED stays dark: wrong port or non-PoE port.
- [ ] Run the welcome wizard: country `United Kingdom`, language `English (UK)`, timezone `Europe/London`; create a user + password (write them on the back of this card); **skip Wi-Fi** (wired); let it update if it insists.
- [ ] Terminal → `sudo raspi-config` → **Interface Options → SSH → Enable**; **System Options → Hostname → `door-kiosk`**; Finish → reboot.
- [ ] From the PC: `ssh <user>@door-kiosk.local` (or the address UniFi shows for `door-kiosk`). **Logged in = stage 2 done.** Keyboard and mouse can come off after stage 3.

> Prefer a clean image? Re-flash with Raspberry Pi Imager as **RPi OS Lite (64-bit)**, set hostname/user/SSH/locale in Imager's settings, skip the wizard. The installer handles either; it also stops the desktop's display manager on a Desktop image.

## 3 · Install the kiosk  (≈ 10 min, mostly apt)

On the Pi over SSH, one block — paste the real token between the single quotes:

```bash
git clone https://github.com/otherlands/SigninApp.git ~/SigninApp
sudo KIOSK_URL=http://192.168.101.102:3000 KIOSK_CARD_TOKEN='<API_TOKEN>' bash ~/SigninApp/deploy/kiosk-pi/install.sh
sudo reboot
```

What the script prints and what it must say:

| Step | Must see | If not |
| --- | --- | --- |
| `== 0 preflight` | `server ok` | The Pi cannot reach `.101.102:3000` — wrong VLAN/port. It exits here on purpose. |
| `== 1 packages` | `cage <ver> · /usr/bin/chromium <ver>` | Chromium package name differs on this OS — note the exact apt error |
| `== 2 kiosk user` | (silent) | — |
| `== 3 kiosk unit` | `unit installed (mode 0600), card token handed in` | "no card token" = the quotes ate it; re-run with the token |
| `== 4 screen never blanks` | `consoleblank=0 added` | — |
| `== 5 metrics + updates` | `node_exporter on :9100` | — |
| `== 6 proof` | `active` + 5 journal lines, then **KIOSK INSTALLED … Address of this Pi: 192.168.101.x** | `activating`/`failed` → `journalctl -u signin-kiosk -n 30` and bring the text back |

- [ ] After `sudo reboot`: **the screen shows the sign-in page full-screen, no desktop, no cursor blink, and stays on.** Write the Pi's address here: `192.168.101.____`
- [ ] Orientation: the 10CS is native landscape 1280×800 — expect no rotation needed. If it comes up rotated, say so; the installer's hint is written for the DSI port and this board is **HDMI**, so the fix will differ (unverified).

## 4 · Prove the card path  (≈ 5 min — this is the first real end-to-end on the kiosk)

- [ ] Plug the **USB-203** into the edge USB. Its light comes on.
- [ ] Present the **white card**: page must say **"Card … is not assigned to anyone"**; Admin (`/admin` from the PC) shows it under **Last unknown card seen**. → reader → browser → token → server all proven in one scan.
- [ ] Present **Alan's blue fob** (`314F6C0A`): page signs Alan **in** (green). Tap again = out.
- [ ] **Byte-order puzzle to close**: the white card typed `3175933060` on the wedge (= `84E44CBD`) but the ESP32 read a white card as `C3621F39` on 27 Sep. Tap **the same white card** here and at the back door and see whether Admin shows one UID or two. One = same card, puzzle solved. Two = two different white cards.
- [ ] Wedge gotcha when enrolling in Admin: **click the card box first**, then scan — otherwise the reader's Enter hits "add person" (that is how the 10 junk `0174870321` people appeared on 30 Sep).

## 5 · Make it permanent  (back at the desk)

- [ ] **UniFi**: DHCP reservation for `door-kiosk` (and, while there, `.101.102` for the server — still owed).
- [ ] **platform-a**: add the Pi's `:9100` to Prometheus so `up{}` for it can alert (pattern in `scripts/deploy-signin-monitoring.sh`, which itself is still to be run: `SIGNIN_ADDR=192.168.101.102 bash scripts/deploy-signin-monitoring.sh`).
- [ ] README: fill the kiosk "Not yet verified" lines with what actually happened (Chromium package name, rotation, first-scan result) and add a history row.
- [ ] Wall: VESA/panel mount at visitor height, Cat 6 to the PoE port, cable dressed; it shares the switch's UPS once there is one.

## Day-to-day on the Pi
`journalctl -u signin-kiosk -f` · `sudo systemctl restart signin-kiosk` (page back in ~5 s) · update = `cd ~/SigninApp && git pull` then re-run the installer line (idempotent).

**Hard stops** — do not push past these, bring the text back instead: preflight not `server ok` · stage 3 unit not `active` · white card not reported as unknown.
