#!/usr/bin/env bash
# Pulls the latest SafeChat from GitHub, installs dependencies when they changed,
# and restarts the service. Run by the safe-chat-update systemd timer every few minutes.
set -euo pipefail
cd /opt/safe-chat
git fetch -q origin main
changed=0
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  changed=1
fi
# Reinstall libraries whenever package-lock.json differs from what was last installed
# (also covers code that was pulled by hand without running npm).
want=$(sha256sum package-lock.json | cut -d' ' -f1)
have=$(cat node_modules/.installed-lock 2>/dev/null || true)
if [ "$want" != "$have" ]; then
  npm ci --omit=dev --silent
  echo "$want" > node_modules/.installed-lock
  changed=1
fi
if [ "$changed" = 1 ]; then
  systemctl restart safe-chat
  echo "SafeChat updated to $(git rev-parse --short HEAD)"
fi
