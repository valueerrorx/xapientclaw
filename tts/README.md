# Xapient TTS – lokaler Sprachdienst

Gibt Xapient eine Stimme: Text-zu-Sprache lokal auf der CPU (keine Cloud) mit
[KittenTTS 2 mini](https://github.com/KittenML/KittenTTS) (ONNX int8, Apache-2.0), Sprache Deutsch.
Der Gateway schickt den Antworttext (vorher aufbereitet, `src/ttsNormalize.js`) an den Dienst und
bekommt eine OGG/Opus-Sprachnachricht zurück.

## Dateien
- `server.py` – HTTP-Dienst (stdlib), lädt das Modell einmal. `GET /health`, `GET /voices`,
  `POST /speak {text, voice?}` → `audio/ogg`. Logs ohne Textinhalt.
- `mixphon.py` + `lexicon/` – englische Wörter in deutschem Text englisch aussprechen
  („Play Store", „Pull Request"). Rein deutsche Sätze bleiben unverändert. Aus mit `TTS_MIXPHON=0`.
- `install.sh` – Installation/Update als root (siehe unten).
- `tts.env.example` – Vorlage für `/opt/kitten-tts/tts.env` (Stimme, Threads, Port).
- `../systemd/xapient-tts.service` – Unit-Vorlage (System-Service).
- `tools/build_lexicon.py` – erzeugt `lexicon/en.txt` + `de.txt` neu, `tools/test_wiring.py` – Test ohne Modell.

## Installation
```
sudo bash tts/install.sh [user]      # user = Dienst-User, Standard: aufrufender User bzw. xapient
curl -s 127.0.0.1:8765/health
```
Läuft auch automatisch im root-Teil von `install-debian.sh` (überspringen mit `WITH_TTS=0`).
Das Skript ist idempotent: venv unter `/opt/kitten-tts/.venv` (Pakete aus `requirements.txt`,
`kittenml==0.9.8` ohne Abhängigkeiten, also ohne torch), Code + Lexikon nach `/opt/kitten-tts`,
Modell einmalig nach `/opt/kitten-tts/model` (Hugging Face `KittenML/kitten-tts-2-mini`, nur ONNX +
deutsche Stimmen, ~90 MB), Unit nach `/etc/systemd/system/xapient-tts.service`, enable + restart.
Voraussetzungen: `python3-venv`, `ffmpeg`, `curl`. `tts.env` wird nie überschrieben.

## Stimme, Port
- Dienst lauscht auf `127.0.0.1:8765` (`TTS_PORT`), der Gateway nutzt `cfg.tts.url`.
- Standardstimme per `KITTEN_VOICE` in `/opt/kitten-tts/tts.env` (eingebaut: Eleanor, Lena, Greta,
  Jonas, Felix, Martha, Serena, Iris, Grace, Edith, Diana, Otis, Vincent).
- Eigene Stimme: Style-Pack als `.npy` (float32 `[510,256]`) über `KITTEN_CUSTOM_VOICE` +
  `KITTEN_CUSTOM_NAME`. Liegt `tts/voices/eigene.npy` vor (gitignored), installiert `install.sh` sie
  nach `/opt/kitten-tts/voices/` und setzt sie bei neuer `tts.env` als Standard („Eigene").
- Nach Änderungen an `tts.env`: `sudo systemctl restart xapient-tts`.

## Wortlisten (mixphon)
`lexicon/en.txt` und `lexicon/de.txt` sind aus den Wortlisten des Projekts
[Wortschatz Leipzig](https://wortschatz.uni-leipzig.de/) abgeleitet (Korpora `eng_news_2023_300K`
und `deu_news_2023_300K`), Lizenz [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
© Wortschatz, Universität Leipzig. Gefiltert und reduziert durch `tools/build_lexicon.py`.
`force_en.txt` / `force_de.txt` sind handgepflegte Ausnahmen (`force_de` gewinnt).

Neu erzeugen (Rohdaten ~160 MB, nicht im Repo):
```
mkdir -p /tmp/lex && cd /tmp/lex
curl -fLO https://downloads.wortschatz-leipzig.de/corpora/deu_news_2023_300K.tar.gz
curl -fLO https://downloads.wortschatz-leipzig.de/corpora/eng_news_2023_300K.tar.gz
tar xzf deu_news_2023_300K.tar.gz && tar xzf eng_news_2023_300K.tar.gz
python3 -I ~/xapient/tts/tools/build_lexicon.py deu_news_2023_300K/deu_news_2023_300K-words.txt \
  eng_news_2023_300K/eng_news_2023_300K-words.txt ~/xapient/tts/lexicon
```
Danach `sudo bash tts/install.sh`.
