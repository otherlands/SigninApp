"""listen_door_reader.py — passive serial listen for the door-reader boot banner.
Opens the port with DTR/RTS LOW before connecting so the USB-Serial-JTAG handshake cannot park a
running app in ROM download mode (lesson 2026-09-05). Usage: python listen_door_reader.py COM11 12"""
import sys, time
import serial

port = sys.argv[1]
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 10
s = serial.Serial()
s.port = port; s.baudrate = 115200; s.timeout = 0.3
s.dtr = False; s.rts = False
s.open()
end = time.time() + secs
buf = b""
while time.time() < end:
    chunk = s.read(4096)
    if chunk:
        buf += chunk
        sys.stdout.write(chunk.decode("utf-8", "replace")); sys.stdout.flush()
s.close()
print(f"\n--- {len(buf)} bytes from {port} in {secs:.0f}s ---")
