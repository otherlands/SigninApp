# eRIGHT Sign-In v3 — staff & visitor register with fire roll call

Small LAN system for a single door: 8 staff, visitors, and a fire marshal who needs to know
**exactly who is inside** from a phone at the assembly point. Node 22.13+ only; no npm
dependencies, no build step. Data is SQLite (Node's built-in `node:sqlite`).

Built 2026-09-25 from the original SigninApp (`tobygladman2/SigninApp` commit `6eab63a`, shared-server
kiosk) plus the useful bits of the separate Home Presence project: SQLite persistence, event IDs for
idempotent retries, API tokens for devices, a mirror/replica, an ESP32 door reader, and a device column
on every event. Deliberately **not** taken from Home Presence: camera motion, BLE presence, geofencing,
and the inferred "auto-away" sign-out — a fire register must only change when a human acts.
The original one-file JSON version is preserved in git history (`git show 6eab63a:server.js`).

## Pages

| URL | Who uses it | What it does |
| --- | --- | --- |
| `/` | Wall tablet by the door | One big button per staff member. Tap = toggle in/out. Shows visitors on site, on-site count, and a red banner while a roll call is running. Listens for a USB card reader. |
| `/visitor` | Visitor at the tablet | Name, company, who they're visiting, vehicle reg, fire-notice tick box. Issues a daily badge number. |
| `/fire` | Marshal's phone, any LAN device | Live "who is on site". **START ROLL CALL** freezes the register at that instant; then SAFE / MISSING per person with the marshal's name and time; counts of safe / missing / not yet seen; END writes a summary event. If the server dies mid-fire the page shows the last register it saw, clearly labelled. Print-friendly. |
| `/admin` | Manager's PC | Add/remove staff, assign card UIDs, close forgotten sign-outs, sign visitors out, company name, fire notice, event log, CSV export, roll-call history. Optional PIN. |
| `/tap` | Staff phone via NFC sticker | The original SigninApp's zero-hardware path: sticker URL → phone remembers who you are → each tap toggles you. |

## Run

```powershell
npm test          # 9 tests, in-memory SQLite, ~0.4 s
npm start         # http://<ip>:3000
```

Environment variables (all optional):

| Var | Purpose |
| --- | --- |
| `PORT`, `HOST` | default 3000 on all interfaces |
| `ADMIN_PIN` | required in `X-Admin-Pin` header for /admin write routes, export, events. Kiosk and fire page never need it. |
| `API_TOKEN` | required in `X-Api-Token` for device sources (`card`, `esp32`, `api`) and alarm-triggered roll calls (`alarm`, `webhook`). Human sources (`kiosk`, `tap`, `fire-page`) never need it. |
| `MIRROR_URL`, `MIRROR_TOKEN` | main server pushes a roster snapshot to the mirror after every change (queued in SQLite, retried every 15 s). |
| `REPLICA=1` | this instance is the read-only mirror. Serves `/fire` from the last snapshot and can run its own roll call. Refuses sign-ins. |
| `TZ_NAME` | IANA zone for "today" and CSV times, default `Europe/London`. |

Data lives in `data/signin.sqlite` (+ `-wal`), git-ignored. Back it up. `deploy/` has systemd
units for main and mirror.

## Fire-safety rules baked into the code

1. **One source of truth.** Every device reads the same server; nothing is stored only on a tablet.
2. **Only deliberate acts change the register.** Kiosk tap, card, NFC tap, visitor form, admin. No sensor inference.
3. **The roll call is a snapshot.** Starting it copies the roster into `rollcalls.roster_json`. People signing out during the evacuation do not disappear from the marshal's list (tested).
4. **Forgotten sign-outs are flagged, never auto-closed.** Anyone signed in before local midnight is amber on the kiosk and marked "⚠ signed in before today" on the fire page. Admin closes them by hand and the event says so. Over-count is the safe failure; silent under-count is not.
5. **The register must outlive the building.** Run the main server off-site or run a `REPLICA` on a second box. The fire page also caches the last roster in the phone's localStorage.
6. **Every event carries who/what/when/where.** `kind, subject, at (UTC), source, device, note`. CSV export has all of them.
7. **Retries are safe.** A device can resend the same `eventKey` and the person is not toggled back (tested).

## Hardware (pick what you like — cheapest first)

| Option | Cost class | Firmware? | Notes |
| --- | --- | --- | --- |
| **Wall tablet** running `/` in kiosk/fullscreen mode | you probably have one | no | Any Android/iPad/old laptop. Add to home screen — the manifest gives a "Fire roll call" shortcut. |
| **USB "keyboard-wedge" NFC/RFID reader** plugged into the tablet or a mini PC | tens of pounds | no | These readers type the card UID + Enter as if they were a keyboard. The kiosk detects the fast burst and posts `cardUid`. Set the token once via Admin → "Set card-reader token on this device". Assign cards in Admin by presenting the card with the cursor in the person's box. Unknown cards are logged and shown in Admin for one-click assignment. **Verified here with synthesised keydown events, not a physical reader.** |
| **NFC stickers** for `/tap` | pence | no | Write the URL `http://<server>/tap` to an NTAG sticker on the door frame. Works with staff phones on the office Wi-Fi. |
| **ESP32-S3 + PN532 door reader** (`firmware/door-reader/`) | ~£15 | yes | Posts card UIDs with a persistent `eventKey` counter; a held button starts a roll call; RGB LED shows result. **Not compiled in this workspace** — build with PlatformIO and bench-test first. |
| **Starting the roll call without touching the fire panel** (we have no access to it) | £0 – ~£20 | no | Three ways, in order of preference: (1) the **START ROLL CALL** button on `/fire` from any phone — this is the primary path and is what was tested; (2) a **stand-alone wall button at the exit or assembly point** — a Shelly Plus i4 / Shelly BLU Button / any device that can call a URL, configured to `POST /api/fire/start` with body `{"source":"webhook","by":"exit button"}` and header `X-Api-Token`; (3) the **hold-button on the ESP32 door reader**. All three are idempotent: a second press while a roll call is open returns `alreadyOpen` and changes nothing. If panel access is ever granted later, the same endpoint accepts a relay-driven trigger — nothing else needs to change. |
| **Second box for the mirror** | any spare Pi/VM | no | `REPLICA=1` + `MIRROR_TOKEN`. Put the mirror's `/fire` URL on the marshal's phone home screen as well. |

## API (for Home Assistant, Node-RED, Shelly, ESP32)

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/health` | `{ok, version, replica, outbox}` |
| GET | `/api/state` | full kiosk state |
| GET | `/api/roster` | who is on site now (staff + visitors) |
| POST | `/api/sign` | `{personId}` or `{cardUid}`; optional `direction:"in"|"out"`, `eventKey`, `source`, `device`, `note` |
| POST | `/api/visitors` | `{name, company?, hostId?, vehicle?}` → 201 with badge |
| POST | `/api/visitors/:id/out` | |
| GET | `/api/fire` | open roll call (with marks) + live roster |
| POST | `/api/fire/start` | `{source, by?}` → 201, or 200 `alreadyOpen` |
| POST | `/api/fire/mark` | `{subjectType:"staff"|"visitor", subjectId, status:"safe"|"missing"|"clear", by?}` |
| POST | `/api/fire/end` | `{by?}` |
| POST | `/api/mirror` | replica intake, `{type:"roster", roster}` |
| admin | `/api/people` (GET/POST), `/api/people/:id` (PATCH name/cardUid/active, DELETE), `PUT /api/company`, `PUT /api/fire-notice`, `POST /api/stale/close`, `GET /api/events`, `GET /api/export?from&to`, `GET /api/fire/history`, `GET /api/visitors/history`, `POST /api/mirror/flush` | |

## What is tested vs. what is not

Tested by `npm test` (all passing on Node 24.13.1): staff toggle and CSV; card sign-in, unknown
card capture, duplicate `eventKey`, double-assignment refusal; visitor badges and sign-out; roll
call snapshot immunity, marks, end summary; stale flagging and admin close; admin PIN scope;
main→mirror push and replica read-only behaviour; BST/GMT midnight; static serving and path
traversal. Driven by hand in a browser: kiosk tap, roll call start/mark/end with red state,
kiosk banner, admin card assignment, wedge listener.

Not tested: a physical card reader, the ESP32 firmware (never compiled), a physical webhook button,
iOS Safari specifics, and running for weeks (watch `data/` size; it is tiny per event).
There is no fire-panel integration: the roll call is started by a person (or a button a person
presses), never by the alarm itself.

## Known limits / next steps

- No per-person PIN: on a trusted door tablet anyone can tap anyone's name. Cards or `/tap` fix this if it matters.
- Admin PIN is a shared secret over plain HTTP on the LAN. Put it behind a reverse proxy with TLS if the network is not trusted.
- The mirror is a roster replica, not a full database replica; roll calls run on the mirror are stored on the mirror.
- Visitor pre-registration, contractor inductions, and photo badges are not built.
