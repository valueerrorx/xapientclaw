#!/usr/bin/env bash
# Installiert/aktualisiert den TTS-Dienst xapient-tts (KittenTTS 2 mini + mixphon) nach /opt/kitten-tts. Idempotent.
#   sudo bash tts/install.sh [user]    (user = Dienst-User, default SUDO_USER oder xapient)
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "bitte als root: sudo bash $0 [user]" >&2; exit 1; }
SVC_USER="${1:-${SUDO_USER:-xapient}}"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DEST=/opt/kitten-tts
KITTENML_VERSION="${KITTENML_VERSION:-0.9.8}"  # mixphon/add_voice nutzen Interna dieser Version
MODEL_REPO="${MODEL_REPO:-KittenML/kitten-tts-2-mini}"
UNIT=/etc/systemd/system/xapient-tts.service

id "$SVC_USER" >/dev/null
for c in python3 ffmpeg; do command -v "$c" >/dev/null || { echo "$c fehlt (apt install python3-venv ffmpeg)" >&2; exit 1; }; done

echo "== venv + pakete"
mkdir -p "$DEST"
[[ -x "$DEST/.venv/bin/python" ]] || python3 -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --upgrade pip
"$DEST/.venv/bin/pip" install -q -r "$HERE/requirements.txt"
"$DEST/.venv/bin/pip" install -q --no-deps "kittenml==$KITTENML_VERSION"

echo "== code + lexikon"
install -m644 "$HERE/server.py" "$HERE/mixphon.py" "$DEST/"
install -d -m755 "$DEST/lexicon"
install -m644 "$HERE"/lexicon/*.txt "$DEST/lexicon/"
if [[ -f "$HERE/voices/eigene.npy" ]]; then  # optionale eigene Stimme (gitignored) -> Default
  install -d -m755 "$DEST/voices"
  install -m644 "$HERE/voices/eigene.npy" "$DEST/voices/eigene.npy"
fi
if [[ ! -f "$DEST/tts.env" ]]; then
  install -m644 "$HERE/tts.env.example" "$DEST/tts.env"
  if [[ -f "$DEST/voices/eigene.npy" ]]; then
    printf 'KITTEN_CUSTOM_VOICE=%s\nKITTEN_CUSTOM_NAME=Eigene\nKITTEN_VOICE=Eigene\n' "$DEST/voices/eigene.npy" >> "$DEST/tts.env"
  fi
fi

echo "== modell $MODEL_REPO"
if [[ ! -f "$DEST/model/config.json" ]]; then
  "$DEST/.venv/bin/python" -I -c 'import sys; from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], local_dir=sys.argv[2],
                  allow_patterns=["config.json", "vocab.json", "voices_de.npz", "kitten_tts_2_mini.onnx"])' \
    "$MODEL_REPO" "$DEST/model"
fi

echo "== systemd ($UNIT, User=$SVC_USER)"
sed "s#%TTS_USER%#$SVC_USER#g" "$HERE/../systemd/xapient-tts.service" > "$UNIT"
if [[ -d "$UNIT.d" ]]; then echo "ACHTUNG: Drop-ins in $UNIT.d/ ueberschreiben die Unit (pruefen/entfernen)"; fi
systemctl daemon-reload
systemctl enable xapient-tts.service
systemctl restart xapient-tts.service

echo "== warte auf /health"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8765/health; then echo; echo "OK"; exit 0; fi
  sleep 2
done
echo "kein /health nach 120 s: journalctl -u xapient-tts -n 50" >&2
exit 1
