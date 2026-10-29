# Xapient TTS – lokaler Sprachdienst

Gibt Xapient eine Stimme: lokaler Text-zu-Sprache-Dienst auf CPU (keine Cloud),
[Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts). Der Gateway schickt
Antworttext an den Dienst und bekommt eine OGG/Opus-Sprachnachricht zurück.

## Architektur
- `server.py` – schlanker HTTP-Dienst (stdlib, RAM-schonend). Lädt das Modell EINMAL.
  - `GET /health` – Status, Modell, Standardstimme
  - `GET /voices` – gecachte Stimmen
  - `POST /speak {text, voice?}` → `audio/ogg`. Lange Texte werden satzweise erzeugt und
    nahtlos zusammengefügt (verhindert zu frühes Abschneiden), dann via ffmpeg zu Opus.
- `run-server.sh` – Startwrapper, lädt `.env`.
- `.env.example` – Vorlage für `~/tts/.env` (Port, Sprache, Standardstimme, optional HF-Token).
- `install-service-root.sh` – installiert den Dienst als System-Service (für Umgebungen
  ohne erreichbaren `systemctl --user`).

## Einrichtung
Macht das Haupt-Setup (`install-debian.sh`): venv unter `~/tts/.venv`, `pip install -r requirements.txt`,
kopiert `server.py`/`run-server.sh` nach `~/tts`, legt `~/tts/.env` aus der Vorlage an.

Manuell/zum Testen:
```
cd ~/tts && ./run-server.sh          # Vordergrund
curl -s 127.0.0.1:8765/health
curl -s -X POST 127.0.0.1:8765/speak -H 'content-type: application/json' \
     -d '{"text":"Grüß dich!"}' -o probe.ogg
```

Dauerbetrieb/reboot-fest:
```
sudo bash ~/tts/install-service-root.sh     # System-Service (startet bei Boot neu)
# oder auf normalen Hosts: systemctl --user enable --now xapient-tts
```

## Stimmen
Eingebaute Katalogstimmen (ohne Anmeldung): weiblich u. a. `anna`, `mary`, `vera`, `alba`,
`eve`, `cosette`; männlich u. a. `juergen`. Standard = `anna` (in `.env`).
Eigene Stimme klonen (`/stimme`) braucht einen HuggingFace-Token + akzeptierte Terms auf
`huggingface.co/kyutai/pocket-tts` — für die Katalogstimmen NICHT nötig.

## Performance
Auf der NAS-CPU (4 Kerne, 3 Threads) ~2× schneller als Echtzeit mit dem `german`-Modell.
Das größere `german_24l` ist deutlich langsamer (~4× langsamer als Echtzeit) → nicht für Live.
