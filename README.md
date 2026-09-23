# LAN sign-in system

A deliberately small, password-free attendance kiosk for a trusted local network. It needs only Node.js (v18+); no database or package installation is required.

## Run it on the VM

1. Copy this folder to the VM and install Node.js LTS if it is not already installed.
2. In this folder, run `npm start`.
3. Find the VM's LAN IP address, then open `http://VM-IP-ADDRESS:3000/` on the wall tablet.
4. Open `http://VM-IP-ADDRESS:3000/admin` from an administrator's computer to manage people, change the company name, and download the CSV log.

## Optional NFC door tap

Program an NFC tag with `http://VM-IP-ADDRESS:3000/tap` (prefer a stable internal hostname, such as `http://signin.local/tap`, if you have one). On a person's first tap, the page asks them to choose their name and remembers that choice on their phone. Future scans automatically sign that person in or out and show confirmation. The phone needs to be connected to the company Wi-Fi.

The service listens on every network interface by default. Allow inbound TCP port 3000 in the VM firewall, but restrict it to your LAN. The `data/sign-in-data.json` file is created automatically and contains all names and the activity log; include it in VM backups.

There is intentionally no password protection. Do not expose this server to the internet. If the admin page needs to be restricted later, put it behind a LAN reverse proxy or add an admin PIN/authentication layer.
