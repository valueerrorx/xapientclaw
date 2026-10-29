# xapient

Minimaler, selbst gehosteter Agent: **Telegram (oder Signal) ↔ Claude Code Master-Agent**, mit Cron-Jobs, Memory und Zugriff auf deine Repos. Node ≥ 20, eine npm-Dependency (`node-ical` für den Morgen-Brief). Spracheingabe über whisper.cpp, Sprachausgabe über einen lokalen pocket-tts-Dienst (CPU, keine Cloud).

```
Telegram-App ──► Bot API (long polling)        [oder: signal-cli daemon]
                     │
                     ▼
              src/gateway.js  ◄── POST /inject ◄── cron ◄── bin/xapient-cron
              (Queue, Session) ◄── POST /send  ◄── bin/xapient-send (vom Agenten)
                     │
                     ▼
        claude -p --resume <session>  (cwd: workspace/, --add-dir /srv/data/thomas/GIT)
              CLAUDE.md · memory/ · cron/*.md · inbox/ · .claude/agents/
```

## Setup (Debian 12/13)

```bash
sudo -u xapient tar xzf xapient.tar.gz -C /home/xapient      # -> /home/xapient/xapient
sudo /home/xapient/xapient/install-debian.sh xapient          # root: apt, node 22, cron, linger
sudo -iu xapient
~/xapient/install-debian.sh                                   # user: claude, systemd unit, config.json
claude                                                        # einmal einloggen, dann /exit
```

### Telegram-Bot anlegen
1. In Telegram **@BotFather** öffnen, `/newbot` senden, als Name `xapient` und als Username z. B. `xapient_thomas_bot` wählen. Du bekommst einen Token.
2. Mit `/setjoingroups` → Disable verhinderst du, dass der Bot in Gruppen hinzugefügt werden kann.
3. Deine **User-ID** bekommst du von **@userinfobot**. Das ist eine Zahl, deine Telefonnummer wird nicht verwendet.
4. In `config.json` trägst du `telegram.token` und `owners: ["<deine-id>"]` ein.
5. Starten (Gateway + Sprachdienst):
```bash
systemctl --user enable --now xapient xapient-tts
journalctl --user -fu xapient
```
6. Den Bot in Telegram öffnen, `/start` drücken und dann `/status` senden.

### Repo-Zugriff
```bash
sudo apt install acl
sudo setfacl -m u:xapient:x /srv/data /srv/data/thomas
sudo setfacl -R -m u:xapient:rwX,u:thomas:rwX /srv/data/thomas/GIT
sudo setfacl -R -d -m u:xapient:rwX,u:thomas:rwX /srv/data/thomas/GIT
sudo -iu xapient git config --global --add safe.directory '*'
sudo -iu xapient git config --global user.name xapient
sudo -iu xapient git config --global user.email xapient@localhost
```

### Signal statt Telegram (optional)
Dafür brauchst du eine eigene Nummer, die SMS oder Anrufe empfangen kann.
```bash
sudo WITH_SIGNAL=1 /home/xapient/xapient/install-debian.sh xapient
# als xapient: signal-cli register/verify/setPin, config: "channel": "signal"
systemctl --user enable --now signal-cli xapient
```

### Morgen-Brief / Kalender (optional)
Täglicher „Guten-Morgen"-Brief (07:00) mit Wetter + Terminen. iCal-URLs kommen in
`workspace/private/calendars.json` (gitignored). Vorlage: `workspace/private/calendars.example.json`
kopieren, echte URLs (WebUntis-Stundenplan, Google privat) + Ort fürs Wetter eintragen.

### Stimme / Sprachausgabe (optional)
Lokaler TTS-Dienst (`tts/`, pocket-tts) auf `127.0.0.1:8765`. Standardstimme `anna` (weibliche
Katalogstimme, keine Anmeldung). Steuerung im Chat: `/voice an|aus|auto`.
- `an` = jede Antwort zusätzlich als Sprachnachricht, `aus` = nur Text,
  `auto` (Standard) = Sprache nur, wenn du selbst eine Sprachnachricht schickst.
- Der Antworttext geht immer sofort raus; die Stimme kommt separat (ein TTS-Ausfall blockiert nie).
- Reboot-fest in einer systemd-Sandbox ohne User-Bus: `sudo bash tts/install-service-root.sh`.
- Eigene Stimme klonen (`/stimme`, geplant) braucht einen HuggingFace-Token in `~/tts/.env`
  + akzeptierte Terms auf `huggingface.co/kyutai/pocket-tts`; für Katalogstimmen nicht nötig.
Details: `tts/README.md`.

## Config
| Key | Bedeutung |
|---|---|
| `channel` | `telegram` (Standard) oder `signal` |
| `owners` | Einzige erlaubte Absender: Telegram-User-ID bzw. Signal-Nummer oder -UUID. `owners[0]` bekommt Agent- und Cron-Nachrichten. |
| `telegram.token` | Bot-Token von @BotFather |
| `http.token` | Shared Secret für `/send` und `/inject` (nur localhost) |
| `claude.addDirs` | Repo-Verzeichnisse, auf die der Agent zugreifen darf |
| `claude.maxTurns` / `timeoutMin` | Limits pro Auftrag |
| `tts` | Lokaler Sprachdienst: `url`, `enabled`, `timeoutMs`, `maxChars` (Defaults greifen auch ohne Eintrag) |

## Befehle im Chat
`/status` · `/new` (neue Session) · `/stop` (Abbruch + Queue leeren) · `/voice an\|aus\|auto` (Sprachantworten) · `/help`

## Konventionen
- Eingehende Prompts sind mit `[telegram …]`, `[signal …]` oder `[cron:NAME …]` markiert.
- Antwortet der Agent mit `NOOP`, wird nichts gesendet. Das ist für Heartbeats gedacht.
- Anhänge (Dokumente, Fotos, Sprachnachrichten) landen in `workspace/inbox/`. Der Agent bekommt den Pfad.
- Cron-Prompts liegen in `workspace/cron/NAME.md`. `xapient-cron` verändert nur Zeilen mit `# xapient:NAME`.
- Chat und Cron teilen sich **eine** Session.

## Sicherheit
- Nachrichten von fremden Absendern werden ignoriert und geloggt, bevor ein Anhang heruntergeladen wird.
- Die Permissions stehen in `workspace/.claude/settings.json`: Allowlist mit `acceptEdits`, sudo und force-push sind gesperrt.
- Der Bot-Token ist das Zugangsgeheimnis. Er liegt nur in `config.json` (Rechte 600).
- **Telegram-Bot-Chats sind nicht Ende-zu-Ende-verschlüsselt.** Telegram kann den Inhalt sehen, also auch Codeausschnitte und Antworten. Für Sensibles nimm Signal.
- Prompt Injection über Web- oder Repo-Inhalte bleibt das Hauptrisiko.

## Erweiterungsideen
- Eigene Stimme per `/stimme` einlernen (pocket-tts Voice-Cloning, HuggingFace-Token)
- Dateien zurückschicken (`sendDocument` / signal `attachments`) plus `xapient-send --file`
- Getrennte Sessions pro Cron-Job
- MCP-Server (Home Assistant, Nextcloud) über `workspace/.mcp.json`

Umgesetzt: Spracheingabe (whisper.cpp) · Sprachausgabe (`/voice`, pocket-tts) · Morgen-Brief (Kalender+Wetter) · detached Langzeit-Jobs (`xapient-job`).
