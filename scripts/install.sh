#!/usr/bin/env bash
# SafeChat installer for a fresh Debian/Ubuntu server (e.g. Google Cloud e2-micro).
# Usage (as a normal user with sudo):
#   curl -fsSL https://raw.githubusercontent.com/kaplanGitLearn/safe-chat/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/kaplanGitLearn/safe-chat.git}"
APP_DIR=/opt/safe-chat
DATA_DIR=/var/lib/safe-chat

echo "== SafeChat: התקנה =="

# Passwords (read from the terminal even when piped through curl)
if [ -z "${PARENT_PASSWORD:-}" ]; then
  read -r -p "בחר סיסמת הורה (לפחות 6 תווים): " PARENT_PASSWORD </dev/tty
fi
if [ -z "${CHILD_PIN:-}" ]; then
  read -r -p "בחר קוד כניסה לילד (לפחות 4 ספרות): " CHILD_PIN </dev/tty
fi
[ ${#PARENT_PASSWORD} -ge 6 ] || { echo "סיסמת הורה קצרה מדי"; exit 1; }
[ ${#CHILD_PIN} -ge 4 ] || { echo "קוד הילד קצר מדי"; exit 1; }

# Small servers (1GB RAM) need swap for npm install
if ! swapon --show | grep -q .; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# Node.js 22
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
fi

# App
sudo id safechat >/dev/null 2>&1 || sudo useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin safechat
if [ -d "$APP_DIR/.git" ]; then sudo git -C "$APP_DIR" pull -q; else sudo git clone -q "$REPO_URL" "$APP_DIR"; fi
(cd "$APP_DIR" && sudo npm ci --omit=dev --silent)
sudo mkdir -p "$DATA_DIR" && sudo chown -R safechat:safechat "$DATA_DIR"

sudo tee /etc/safe-chat.env >/dev/null <<ENV
PARENT_PASSWORD=$PARENT_PASSWORD
CHILD_PIN=$CHILD_PIN
DATA_DIR=$DATA_DIR
HOST=127.0.0.1
PORT=3000
ENV
sudo chmod 600 /etc/safe-chat.env

sudo tee /etc/systemd/system/safe-chat.service >/dev/null <<UNIT
[Unit]
Description=SafeChat
After=network-online.target
Wants=network-online.target

[Service]
User=safechat
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/safe-chat.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

# Public address: <ip>.sslip.io gives a free hostname so HTTPS works without buying a domain
IP=$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || curl -fs https://api.ipify.org)
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
echo "$DOMAIN {
  reverse_proxy 127.0.0.1:3000
}" | sudo tee /etc/caddy/Caddyfile >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now safe-chat >/dev/null
sudo systemctl restart safe-chat caddy

echo
echo "== ההתקנה הסתיימה =="
echo "פאנל הורים:  https://$DOMAIN/admin.html"
echo "אפליקציית הילד: https://$DOMAIN"
echo "(ייתכן שיעברו כדקה עד שהכתובת תעבוד)"
