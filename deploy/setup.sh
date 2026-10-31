#!/usr/bin/env bash
# TryDesk server setup for Ubuntu 22.04+. Safe to re-run (keeps the existing TURN secret).
# Usage:  sudo -E bash setup.sh   (-E keeps SSH_CONNECTION so the current SSH port is whitelisted)
# Override: DESK_DOMAIN=desk.example.com TURN_DOMAIN=turn.example.com PUBLIC_IP=1.2.3.4 SKIP_FIREWALL=1 sudo -E bash setup.sh
set -euo pipefail

DESK_DOMAIN="${DESK_DOMAIN:-desk.trydesk.ai.id}"
TURN_DOMAIN="${TURN_DOMAIN:-turn.trydesk.ai.id}"
# 3478 is often blocked by Indonesian ISPs; 8443 (HTTPS-alt) usually passes
TURN_PORT="${TURN_PORT:-8443}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

[ "$(id -u)" -eq 0 ] || { echo "Jalankan sebagai root: sudo -E bash setup.sh"; exit 1; }
[ -f ../server/signaling-server.js ] || { echo "Folder ../server tidak ditemukan. Upload folder server/ dan deploy/ berdampingan."; exit 1; }

echo "==> [1/6] Install Docker"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker.io
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin
fi
systemctl enable --now docker

echo "==> [2/6] Deteksi IP publik"
PUBLIC_IP="${PUBLIC_IP:-$(curl -4 -fsS --max-time 5 https://api.ipify.org || true)}"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
LOCAL_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
# On NAT clouds (e.g. Oracle) the public IP is not on any interface: coturn needs "public/private"
if [ "$LOCAL_IP" = "$PUBLIC_IP" ]; then EXTERNAL_IP="$PUBLIC_IP"; else EXTERNAL_IP="$PUBLIC_IP/$LOCAL_IP"; fi
echo "    IP publik: $PUBLIC_IP  |  IP interface: $LOCAL_IP"

echo "==> [3/6] Cek DNS"
dns_ok=1
for d in "$DESK_DOMAIN" "$TURN_DOMAIN"; do
  resolved="$(getent ahostsv4 "$d" | awk 'NR==1{print $1}' || true)"
  if [ "$resolved" != "$PUBLIC_IP" ]; then
    echo "    !! $d -> '${resolved:-tidak ada}' (harusnya $PUBLIC_IP)."
    echo "       Di Cloudflare: record A $d -> $PUBLIC_IP dengan Proxy status = DNS only (awan abu-abu)."
    dns_ok=0
  else
    echo "    OK $d -> $resolved"
  fi
done
if [ "$dns_ok" -eq 0 ] && [ "${IGNORE_DNS:-0}" != "1" ]; then
  echo "Perbaiki DNS dulu (sertifikat HTTPS akan gagal), lalu jalankan ulang. Paksa lanjut: IGNORE_DNS=1"
  exit 1
fi

echo "==> [4/6] Konfigurasi"
if [ -f .env ] && grep -q '^TURN_SECRET=' .env; then
  TURN_SECRET="$(grep '^TURN_SECRET=' .env | cut -d= -f2-)"
else
  TURN_SECRET="$(openssl rand -hex 32)"
fi
# Any other settings you added to .env yourself are kept across re-runs.
EXTRA_ENV=""
[ -f .env ] && EXTRA_ENV="$(grep -vE '^(DESK_DOMAIN|TURN_DOMAIN|TURN_SECRET|TURN_PORT)=' .env || true)"
cat > .env <<EOF
DESK_DOMAIN=$DESK_DOMAIN
TURN_DOMAIN=$TURN_DOMAIN
TURN_SECRET=$TURN_SECRET
TURN_PORT=$TURN_PORT
EOF
[ -n "$EXTRA_ENV" ] && printf '%s\n' "$EXTRA_ENV" >> .env
chmod 600 .env

cat > turnserver.conf <<EOF
listening-port=$TURN_PORT
listening-ip=$LOCAL_IP
relay-ip=$LOCAL_IP
external-ip=$EXTERNAL_IP
realm=$TURN_DOMAIN
server-name=$TURN_DOMAIN
use-auth-secret
static-auth-secret=$TURN_SECRET
fingerprint
min-port=49160
max-port=49260
no-tls
no-dtls
no-cli
no-multicast-peers
no-tcp-relay
total-quota=100
user-quota=12
stale-nonce=600
# Never relay into private / local networks (protects the VPS's own network)
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
# Holds the TURN static-auth-secret: readable only by root and the coturn image's user (nobody, 65534).
# Root-only 600 is NOT enough: coturn then silently falls back to defaults (port 3478, no secret).
chown 65534:65534 turnserver.conf
chmod 600 turnserver.conf

echo "==> [5/6] Firewall (ufw)"
if [ "${SKIP_FIREWALL:-0}" = "1" ]; then
  echo "    dilewati (SKIP_FIREWALL=1)"
else
  command -v ufw >/dev/null 2>&1 || apt-get install -y ufw
  # Allow every port sshd is actually listening on BEFORE enabling, so the session is never locked out
  ssh_ports="$(ss -tlnpH 2>/dev/null | awk '/sshd|"systemd",.*ssh/ {n=split($4,a,":"); print a[n]}' || true)"
  # Port of the SSH session running this script (covers socket-activated ssh on Ubuntu 24.04)
  [ -n "${SSH_CONNECTION:-}" ] && ssh_ports="$ssh_ports $(echo "$SSH_CONNECTION" | awk '{print $4}')"
  ssh_ports="$(echo $ssh_ports 22 | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un)"
  for p in $ssh_ports; do ufw allow "$p"/tcp >/dev/null; echo "    SSH port $p diizinkan"; done
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "$TURN_PORT"/tcp >/dev/null
  ufw allow "$TURN_PORT"/udp >/dev/null
  ufw allow 49160:49260/udp >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/    /'
fi

echo "==> [6/6] Jalankan layanan"
docker compose up -d --build
echo "    Menunggu sertifikat HTTPS..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DESK_DOMAIN" >/dev/null 2>&1; then break; fi
  sleep 3
done

echo
if curl -fsS --max-time 5 "https://$DESK_DOMAIN"; then
  echo "SELESAI. Server online: wss://$DESK_DOMAIN  |  TURN: $TURN_DOMAIN:$TURN_PORT"
else
  echo "Layanan jalan tapi https://$DESK_DOMAIN belum bisa diakses. Cek log: docker compose logs caddy"
fi
echo "Jika firewall di panel provider aktif, buka juga: TCP 80,443,$TURN_PORT dan UDP $TURN_PORT,49160-49260."
