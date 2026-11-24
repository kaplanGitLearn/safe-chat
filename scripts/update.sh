#!/usr/bin/env bash
# Pulls the latest SafeChat from GitHub and restarts the service if anything changed.
# Run by the safe-chat-update systemd timer every few minutes.
set -euo pipefail
cd /opt/safe-chat
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
old_lock=$(git rev-parse HEAD:package-lock.json)
git reset -q --hard origin/main
if [ "$old_lock" != "$(git rev-parse HEAD:package-lock.json)" ]; then
  npm ci --omit=dev --silent
fi
systemctl restart safe-chat
echo "SafeChat updated to $(git rev-parse --short HEAD)"
