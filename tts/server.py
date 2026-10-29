#!/usr/bin/env python3
"""Xapient TTS-Dienst: laedt das pocket-tts-Modell EINMAL und spricht auf Zuruf.

Schlank gehalten (stdlib http.server statt FastAPI/uvicorn, spart RAM). Eine Synthese
zur Zeit (Modell ist nicht thread-safe -> Lock). Logs ohne Textinhalt (nur Laenge/Dauer/RTF).

Endpunkte:
  GET  /health          -> JSON: Status, Modell, Sprache, Standardstimme, gecachte Stimmen
  GET  /voices          -> JSON: bekannte/gecachte Stimmen
  POST /speak {text, voice?} -> audio/ogg (Opus). Lange Texte werden satzweise erzeugt
                               und nahtlos zusammengefuegt (verhindert fruehes Abschneiden).

Konfig ueber Umgebung (aus ~/tts/.env geladen vom systemd-Service):
  TTS_HOST (127.0.0.1), TTS_PORT (8765), TTS_LANGUAGE (german),
  TTS_DEFAULT_VOICE (mary), TTS_THREADS (nproc-1).
"""
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

from pocket_tts.data.audio import stream_audio_chunks
from pocket_tts.models.tts_model import TTSModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("xapient-tts")

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8765"))
LANGUAGE = os.environ.get("TTS_LANGUAGE", "german")
DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "mary")
THREADS = int(os.environ.get("TTS_THREADS", str(max(1, (os.cpu_count() or 2) - 1))))
GAP_SECONDS = 0.12  # kurze Pause zwischen Saetzen

torch.set_num_threads(THREADS)

# --- Modell einmal laden -----------------------------------------------------
log.info("Lade Modell (language=%s, threads=%d) ...", LANGUAGE, THREADS)
MODEL = TTSModel.load_model(language=LANGUAGE)
MODEL.to("cpu")
SAMPLE_RATE = int(getattr(MODEL, "sample_rate", None) or MODEL.config.mimi.sample_rate)
log.info("Modell geladen. sample_rate=%d", SAMPLE_RATE)

_voice_states = {}            # name/pfad -> ModelState (Cache)
_voice_lock = threading.Lock()  # schuetzt den Cache
_synth_lock = threading.Lock()  # serialisiert die Synthese (Modell nicht thread-safe)


def get_voice_state(voice):
    """ModelState fuer eine Stimme (Name wie 'mary', WAV- oder .safetensors-Pfad). Gecacht."""
    with _voice_lock:
        st = _voice_states.get(voice)
        if st is None:
            log.info("Encode Stimme '%s' ...", voice)
            st = MODEL.get_state_for_audio_prompt(voice)
            _voice_states[voice] = st
        return st


def split_sentences(text):
    """Text an Satzgrenzen (.!?) in Einzelsaetze teilen; leere raus."""
    text = " ".join(text.split())
    parts = re.split(r"(?<=[.!?…])\s+", text)
    return [p.strip() for p in parts if p.strip()]


def synth_wav(text, voice, wav_path):
    """Satzweise erzeugen und als eine WAV schreiben. Gibt (audio_sek, gen_sek) zurueck."""
    state = get_voice_state(voice)
    sentences = split_sentences(text) or [text.strip()]
    chunks = []
    dtype = None
    t0 = time.time()
    for i, sentence in enumerate(sentences):
        for ch in MODEL.generate_audio_stream(
            model_state=state, text_to_generate=sentence, copy_state=True
        ):
            if dtype is None:
                dtype = ch.dtype
            chunks.append(ch)
        if i < len(sentences) - 1 and dtype is not None:
            chunks.append(torch.zeros(int(GAP_SECONDS * SAMPLE_RATE), dtype=dtype))
    gen_sec = time.time() - t0
    stream_audio_chunks(wav_path, iter(chunks), SAMPLE_RATE)
    total_samples = sum(int(c.shape[-1]) for c in chunks)
    return total_samples / SAMPLE_RATE, gen_sec


def wav_to_ogg(wav_path, ogg_path):
    """WAV -> OGG/Opus (mono, 48k) via ffmpeg."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-c:a", "libopus", "-b:a", "48k",
         "-ar", "48000", "-ac", "1", ogg_path],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def synth_ogg(text, voice):
    """Kompletter Pfad Text -> OGG-Bytes. Serialisiert (ein Modell)."""
    with _synth_lock:
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "out.wav")
            ogg = os.path.join(d, "out.ogg")
            audio_sec, gen_sec = synth_wav(text, voice, wav)
            wav_to_ogg(wav, ogg)
            with open(ogg, "rb") as f:
                data = f.read()
    rtf = (audio_sec / gen_sec) if gen_sec > 0 else 0.0
    log.info("speak: chars=%d voice=%s audio=%.1fs gen=%.1fs rtf=%.2fx ogg=%dB",
             len(text), voice, audio_sec, gen_sec, rtf, len(data))
    return data


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # eigenes Logging, kein stderr-Spam
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {
                "status": "ok", "model": LANGUAGE, "language": LANGUAGE,
                "default_voice": DEFAULT_VOICE, "sample_rate": SAMPLE_RATE,
                "threads": THREADS, "voices_cached": sorted(_voice_states.keys()),
            })
        elif self.path.startswith("/voices"):
            self._json(200, {"default": DEFAULT_VOICE, "cached": sorted(_voice_states.keys())})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/speak"):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(n) or b"{}")
            text = (payload.get("text") or "").strip()
            voice = (payload.get("voice") or DEFAULT_VOICE).strip()
            if not text:
                self._json(400, {"error": "text fehlt"})
                return
            data = synth_ogg(text, voice)
        except Exception as e:  # noqa: BLE001 - Fehler sauber als 500 zurueck
            log.exception("speak-Fehler")
            self._json(500, {"error": str(e)[:200]})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/ogg")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    # Standardstimme vorab encoden, damit die erste Anfrage nicht wartet.
    get_voice_state(DEFAULT_VOICE)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("TTS-Dienst laeuft auf http://%s:%d (Stimme=%s)", HOST, PORT, DEFAULT_VOICE)
    srv.serve_forever()


if __name__ == "__main__":
    main()
