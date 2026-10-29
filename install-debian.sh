#!/usr/bin/env bash
# xapient installer for debian 12/13: run once as root (system part), then as xapient user (user part)
#   sudo ./install-debian.sh xapient     -> apt, node, cron, linger (WITH_SIGNAL=1 adds signal-cli)
#   ./install-debian.sh                  -> (as xapient) claude, systemd units, config
set -euo pipefail

SIGNAL_CLI_VERSION="${SIGNAL_CLI_VERSION:-0.14.1}"  # override via env
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

system_part() {
  local user="${1:?usage: sudo $0 <username>}"
  local arch; arch="$(dpkg --print-architecture)"

  say "apt pakete"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git git-lfs cron jq openssl ffmpeg cmake build-essential \
    python3-venv python3-pip python3-dev libsndfile1  # python3* + libsndfile: lokaler TTS-Dienst (pocket-tts)

  say "node >= 20"
  if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -  # debian 12 ships node 18
    apt-get install -y -qq nodejs
  fi
  node --version

  if [[ "${WITH_SIGNAL:-0}" == 1 ]] && ! command -v signal-cli >/dev/null; then  # only for signal channel
    say "signal-cli $SIGNAL_CLI_VERSION ($arch)"
    local base="https://github.com/AsamK/signal-cli/releases/download/v$SIGNAL_CLI_VERSION" tmp
    if [[ "$arch" == amd64 ]]; then
      tmp="$(mktemp -d)"
      curl -fL "$base/signal-cli-$SIGNAL_CLI_VERSION-Linux-native.tar.gz" | tar xz -C "$tmp"  # graalvm build, no java
      install -m755 "$(find "$tmp" -type f -name signal-cli | head -1)" /usr/local/bin/signal-cli
      rm -rf "$tmp"
    else
      apt-get install -y -qq openjdk-21-jre-headless || { echo "java 21+ fehlt (debian 12: temurin-21 via adoptium.net)"; exit 1; }
      curl -fL "$base/signal-cli-$SIGNAL_CLI_VERSION.tar.gz" | tar xz -C /opt
      ln -sf "/opt/signal-cli-$SIGNAL_CLI_VERSION/bin/signal-cli" /usr/local/bin/signal-cli
    fi
    signal-cli --version
  fi

  if ! command -v gitleaks >/dev/null; then  # pflicht für den push-datenschutz-check
    say "gitleaks ($arch)"
    local gl="${GITLEAKS_VERSION:-8.21.2}" gltmp
    if [[ "$arch" == amd64 ]]; then
      gltmp="$(mktemp -d)"
      curl -fL "https://github.com/gitleaks/gitleaks/releases/download/v$gl/gitleaks_${gl}_linux_x64.tar.gz" | tar xz -C "$gltmp"
      install -m755 "$gltmp/gitleaks" /usr/local/bin/gitleaks
      rm -rf "$gltmp"
    elif [[ "$arch" == arm64 ]]; then
      gltmp="$(mktemp -d)"
      curl -fL "https://github.com/gitleaks/gitleaks/releases/download/v$gl/gitleaks_${gl}_linux_arm64.tar.gz" | tar xz -C "$gltmp"
      install -m755 "$gltmp/gitleaks" /usr/local/bin/gitleaks
      rm -rf "$gltmp"
    else
      echo "gitleaks: arch $arch -> bitte manuell installieren"
    fi
    command -v gitleaks >/dev/null && gitleaks version
  fi

  say "cron + linger für $user"
  systemctl enable --now cron
  loginctl enable-linger "$user"
  echo "fertig. weiter als $user:  sudo -iu $user  &&  ~/xapient/install-debian.sh"
}

user_part() {
  say "claude code"
  export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
  claude --version

  say "git-lfs (für repos mit LFS, z. B. ai-trader)"
  git lfs install

  say "whisper.cpp + modell ggml-small (lokale spracherkennung für voice)"
  local wd="$HOME/whisper.cpp"
  if [[ ! -x "$wd/build/bin/whisper-cli" ]]; then
    [[ -d "$wd/.git" ]] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$wd"
    cmake -B "$wd/build" -S "$wd"
    cmake --build "$wd/build" -j --config Release
  fi
  [[ -f "$wd/models/ggml-small.bin" ]] || "$wd/models/download-ggml-model.sh" small
  echo "whisper-cli: $wd/build/bin/whisper-cli  modell: $wd/models/ggml-small.bin"

  say "node-abhaengigkeiten (gateway, node-ical fuer den morgen-brief)"
  ( cd "$HERE" && npm install --no-audit --no-fund )

  say "tts-dienst (pocket-tts, lokale stimme)"
  local td="$HOME/tts"
  mkdir -p "$td/voices"
  [[ -x "$td/.venv/bin/python" ]] || python3 -m venv "$td/.venv"
  "$td/.venv/bin/pip" install -q --upgrade pip wheel
  "$td/.venv/bin/pip" install -q -r "$HERE/tts/requirements.txt"
  cp "$HERE/tts/server.py" "$HERE/tts/run-server.sh" "$td/"
  if [[ ! -f "$td/.env" ]]; then cp "$HERE/tts/.env.example" "$td/.env"; echo "~/tts/.env aus Vorlage angelegt"; fi
  chmod 600 "$td/.env"
  echo "tts bereit in $td (Start: $td/run-server.sh  |  reboot-fest: sudo bash $HERE/tts/install-service-root.sh)"

  say "systemd user units"
  mkdir -p ~/.config/systemd/user
  sed "s#%XAPIENT_DIR%#$HERE#g" "$HERE/systemd/xapient.service" > ~/.config/systemd/user/xapient.service
  [[ -x /usr/local/bin/signal-cli ]] && cp "$HERE/systemd/signal-cli.service" ~/.config/systemd/user/
  cp "$HERE/systemd/xapient-tts.service" ~/.config/systemd/user/  # lokaler sprachdienst
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"  # needed after sudo -iu
  systemctl --user daemon-reload

  say "config"
  if [[ ! -f "$HERE/config.json" ]]; then
    jq --arg t "$(openssl rand -hex 24)" '.http.token = $t' "$HERE/config.example.json" > "$HERE/config.json"
    echo "config.json angelegt (token gesetzt)"
  fi
  chmod 600 "$HERE/config.json"

  mkdir -p "$HERE/workspace/private"
  if [[ ! -f "$HERE/workspace/private/calendars.json" ]]; then
    cp "$HERE/workspace/private/calendars.example.json" "$HERE/workspace/private/calendars.json"
    echo "calendars.json aus Vorlage angelegt (echte iCal-URLs eintragen!)"
  fi

  say "setup-check (was noch fehlt)"
  local miss=0
  grep -q '123456:ABC' "$HERE/config.json" 2>/dev/null && { echo "  [ ] telegram.token in config.json (noch Platzhalter)"; miss=1; }
  grep -q '"123456789"' "$HERE/config.json" 2>/dev/null && { echo "  [ ] owners in config.json (noch Platzhalter)"; miss=1; }
  grep -q 'DEINE-SCHULE\|DEINE-ADRESSE' "$HERE/workspace/private/calendars.json" 2>/dev/null && { echo "  [ ] echte iCal-URLs in workspace/private/calendars.json (Morgen-Brief)"; miss=1; }
  [[ -f "$HOME/whisper.cpp/models/ggml-small.bin" ]] || { echo "  [ ] whisper-modell (Spracheingabe) fehlt"; miss=1; }
  [[ "$miss" == 0 ]] && echo "  alles gesetzt."

  cat <<EOF

Nächste Schritte (als $(whoami)):
  1. claude                                    # einmal einloggen
  2. telegram: @BotFather -> /newbot -> token; eigene user-id via @userinfobot
  3. nano $HERE/config.json                    # telegram.token, owners, claude.addDirs
  4. nano $HERE/workspace/private/calendars.json   # eigene iCal-URLs (Stundenplan/Privat) + Ort fürs Wetter
  5. systemctl --user enable --now xapient xapient-tts
     journalctl --user -fu xapient
  Hinweis Sprache: Standardstimme 'anna' (keine Anmeldung). Eigene Stimme (/stimme) braucht
  einen HuggingFace-Token in ~/tts/.env + akzeptierte Terms auf huggingface.co/kyutai/pocket-tts.
  In einer systemd-Sandbox ohne User-Bus statt (5): sudo bash $HERE/tts/install-service-root.sh
EOF
}

if [[ $EUID -eq 0 ]]; then system_part "$@"; else user_part; fi
