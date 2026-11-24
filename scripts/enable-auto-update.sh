#!/usr/bin/env bash
# Turns on automatic updates from GitHub (checks every 5 minutes). Run with sudo.
set -euo pipefail
cat > /etc/systemd/system/safe-chat-update.service <<UNIT
[Unit]
Description=Update SafeChat from GitHub
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/safe-chat/scripts/update.sh
UNIT
cat > /etc/systemd/system/safe-chat-update.timer <<UNIT
[Unit]
Description=Check for SafeChat updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now safe-chat-update.timer >/dev/null
/bin/bash /opt/safe-chat/scripts/update.sh || true
echo "עדכון אוטומטי הופעל ✓"
