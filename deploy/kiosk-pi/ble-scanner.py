#!/usr/bin/env python3
"""ble-scanner.py — BLE presence scanner for the Raspberry Pi kiosk (front door) or any Linux box with Bluetooth.

Hears staff key tags (iBeacon frames or beacons with a fixed public address) and POSTs batched sightings to the
sign-in server's /api/presence/ble every POST_S seconds. Phones with random addresses are ignored: they are not
identities. Mirrors the ESP32 firmware's tag format exactly so a tag is the same string on every scanner:
    ibeacon:<UUID>:<major>:<minor>      or      mac:AA:BB:CC:DD:EE:FF

Env:  SIGNIN_URL (default http://192.168.101.102:3000)  SIGNIN_TOKEN (API_TOKEN)  SCANNER_NAME (default front-door)
      POST_S (default 5)
Deps: pip install bleak   (BlueZ on the Pi; run as a user in the `bluetooth` group or as root via systemd)
Not yet run on real hardware (written 2026-09-27); the Pi kiosk parts are on order.
"""
import asyncio, json, os, sys, time, urllib.request

try:
    from bleak import BleakScanner
except ImportError:
    print("bleak missing: pip install bleak", file=sys.stderr); sys.exit(1)

URL = os.environ.get("SIGNIN_URL", "http://192.168.101.102:3000").rstrip("/")
TOKEN = os.environ.get("SIGNIN_TOKEN", "")
NAME = os.environ.get("SCANNER_NAME", "front-door")
POST_S = float(os.environ.get("POST_S", "5"))
APPLE = 0x004C

seen: dict[str, int] = {}          # tag -> strongest rssi this window
posted = tags = 0

def tag_of(device, adv):
    md = adv.manufacturer_data.get(APPLE)
    if md and len(md) >= 23 and md[0] == 0x02 and md[1] == 0x15:
        u = md[2:18]
        uuid = "%s-%s-%s-%s-%s" % (u[0:4].hex(), u[4:6].hex(), u[6:8].hex(), u[8:10].hex(), u[10:16].hex())
        major = int.from_bytes(md[18:20], "big"); minor = int.from_bytes(md[20:22], "big")
        return f"ibeacon:{uuid.upper()}:{major}:{minor}"
    # bleak exposes address type on Linux via details; treat as fixed when BlueZ says "public"
    props = getattr(device, "details", {}) or {}
    addr_type = (props.get("props", {}) if isinstance(props, dict) else {}).get("AddressType")
    if addr_type == "public":
        return "mac:" + device.address.upper()
    return None

def on_adv(device, adv):
    t = tag_of(device, adv)
    if not t: return
    r = adv.rssi if adv.rssi is not None else -100
    if t not in seen or r > seen[t]: seen[t] = r

def post():
    global posted, tags
    if not seen: return
    body = json.dumps({"scanner": NAME, "sightings": [{"tag": t, "rssi": r} for t, r in seen.items()]}).encode()
    n = len(seen); seen.clear()
    req = urllib.request.Request(f"{URL}/api/presence/ble", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Api-Token": TOKEN, "X-Device": NAME})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            if res.status == 200: posted += 1; tags += n
            else: print(f"[{time.strftime('%FT%TZ', time.gmtime())}] server {res.status}", flush=True)
    except Exception as e:
        print(f"[{time.strftime('%FT%TZ', time.gmtime())}] post failed: {e}", flush=True)

async def main():
    print(f"[{time.strftime('%FT%TZ', time.gmtime())}] ble-scanner '{NAME}' -> {URL} every {POST_S}s", flush=True)
    scanner = BleakScanner(on_adv, scanning_mode="passive")
    await scanner.start()
    last_status = time.time()
    try:
        while True:
            await asyncio.sleep(POST_S)
            post()
            if time.time() - last_status >= 60:
                last_status = time.time()
                print(f"[{time.strftime('%FT%TZ', time.gmtime())}] status batches={posted} tags={tags}", flush=True)
    finally:
        await scanner.stop()

if __name__ == "__main__":
    asyncio.run(main())
