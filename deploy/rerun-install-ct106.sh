#!/usr/bin/env bash
# rerun-install-ct106.sh — pull the installer fix and finish the install on CT 106 (steps 3-5 never ran).
set -uo pipefail
git -C /root/SigninApp pull --ff-only -q && echo "checkout $(git -C /root/SigninApp log --oneline -1 | cut -c1-60)"
REPO_URL=https://github.com/otherlands/SigninApp.git bash /root/SigninApp/deploy/install-ubuntu-vm.sh
echo "== read-back =="
systemctl is-active eright-signin
curl -s -m 5 http://127.0.0.1:3000/metrics | grep -E '^signin_(up|info|on_site_total|rollcall_open)'
