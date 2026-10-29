#!/usr/bin/env bash
set -euo pipefail
# Installiert den Xapient-TTS-Dienst als SYSTEM-Service (wenn `systemctl --user` nicht
# erreichbar ist, z. B. in einer systemd-Sandbox ohne User-Bus).
# Laeuft als angegebener User, startet bei Boot + nach Absturz neu. Idempotent.
#   sudo bash install-service-root.sh [username]   (default: SUDO_USER oder 'xapient')

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte als root ausfuehren:  sudo bash $0 [username]" >&2
  exit 1
fi

SVC_USER="${1:-${SUDO_USER:-xapient}}"
SVC_HOME="$(getent passwd "$SVC_USER" | cut -d: -f6)"
TTS_DIR="$SVC_HOME/tts"
[ -x "$TTS_DIR/.venv/bin/python" ] || { echo "Kein venv in $TTS_DIR/.venv — erst Setup laufen lassen." >&2; exit 1; }

UNIT=/etc/systemd/system/xapient-tts.service
cat > "$UNIT" <<EOF
[Unit]
Description=Xapient TTS (pocket-tts) lokaler Sprachdienst
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$TTS_DIR/.env
ExecStart=$TTS_DIR/.venv/bin/python $TTS_DIR/server.py
Restart=on-failure
RestartSec=3
ProtectSystem=strict
ReadWritePaths=$TTS_DIR
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "Unit geschrieben: $UNIT (User=$SVC_USER, Dir=$TTS_DIR)"
systemctl daemon-reload
systemctl enable --now xapient-tts.service
echo "--- Status ---"
systemctl --no-pager --full status xapient-tts.service | head -12 || true
echo "OK. Test:  curl -s http://127.0.0.1:8765/health"
