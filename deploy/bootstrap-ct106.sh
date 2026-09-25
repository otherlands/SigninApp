#!/usr/bin/env bash
# bootstrap-ct106.sh — first-boot of the `signin` container (Proxmox CT 106, Ubuntu 24.04 LXC), 2026-09-25.
# Piped over ssh as root: type this | ssh root@192.168.101.102 bash
# Steps: apt update/upgrade + git/curl/ca-certs/openssl · timezone · Node 22 (NodeSource) · clone SigninApp ·
# deploy/install-ubuntu-vm.sh (creates user, env with GENERATED PIN/token, unit, /metrics proof).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "== host =="; hostname; . /etc/os-release; echo "$PRETTY_NAME"; ip -4 -brief addr show eth0
echo "== apt =="
apt-get update -qq
apt-get -y -qq upgrade >/dev/null
apt-get install -y -qq git curl ca-certificates openssl gnupg >/dev/null
timedatectl set-timezone Europe/London 2>/dev/null || ln -sf /usr/share/zoneinfo/Europe/London /etc/localtime
echo "  tz: $(date +%Z) $(date -u +%FT%TZ)"
echo "== node 22 =="
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node --version)"
echo "== clone =="
if [ -d /root/SigninApp/.git ]; then git -C /root/SigninApp pull --ff-only -q; else git clone -q https://github.com/otherlands/SigninApp.git /root/SigninApp; fi
echo "  $(git -C /root/SigninApp log --oneline -1)"
echo "== install =="
REPO_URL=https://github.com/otherlands/SigninApp.git bash /root/SigninApp/deploy/install-ubuntu-vm.sh
