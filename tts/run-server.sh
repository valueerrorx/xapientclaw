#!/usr/bin/env bash
set -euo pipefail
# Startet den TTS-Dienst. Konfig/Secrets aus <dir>/.env (nicht im Cmd sichtbar).
# HERE-basiert -> laeuft egal wo ~/tts liegt.
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ -f "$HERE/.env" ] && { set -a; . "$HERE/.env"; set +a; }
exec "$HERE/.venv/bin/python" "$HERE/server.py"
