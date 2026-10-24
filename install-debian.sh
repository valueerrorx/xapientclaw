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
  apt-get install -y -qq curl ca-certificates git cron jq openssl

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

  say "systemd user units"
  mkdir -p ~/.config/systemd/user
  sed "s#%XAPIENT_DIR%#$HERE#g" "$HERE/systemd/xapient.service" > ~/.config/systemd/user/xapient.service
  [[ -x /usr/local/bin/signal-cli ]] && cp "$HERE/systemd/signal-cli.service" ~/.config/systemd/user/
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"  # needed after sudo -iu
  systemctl --user daemon-reload

  say "config"
  if [[ ! -f "$HERE/config.json" ]]; then
    jq --arg t "$(openssl rand -hex 24)" '.http.token = $t' "$HERE/config.example.json" > "$HERE/config.json"
    echo "config.json angelegt (token gesetzt)"
  fi
  chmod 600 "$HERE/config.json"

  cat <<EOF

Nächste Schritte (als $(whoami)):
  1. claude                                    # einmal einloggen
  2. telegram: @BotFather -> /newbot -> token; eigene user-id via @userinfobot
  3. nano $HERE/config.json                    # telegram.token, owners, claude.addDirs
  4. systemctl --user enable --now xapient
     journalctl --user -fu xapient
EOF
}

if [[ $EUID -eq 0 ]]; then system_part "$@"; else user_part; fi
