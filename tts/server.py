#!/usr/bin/env python3
"""Xapient TTS-Dienst (KittenTTS 2 mini, ONNX int8). Gleiche API wie der alte pocket-tts-Server:
  GET  /health  -> JSON-Status
  GET  /voices  -> JSON: deutsche Stimmen
  POST /speak {text, voice?} -> audio/ogg (Opus, mono, 48 kHz)
Konfig per Umgebung: KITTEN_MODEL (Pfad/Repo), KITTEN_VOICE (Eleanor), KITTEN_THREADS (3),
TTS_HOST (127.0.0.1), TTS_PORT (8765). Logs ohne Textinhalt."""
import json, logging, os, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from kittenml import KittenTTS2Tiny

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("xapient-tts")
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8765"))
MODEL_PATH = os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-2-mini")
VOICE = os.environ.get("KITTEN_VOICE", "Eleanor")
THREADS = int(os.environ.get("KITTEN_THREADS", "3"))
SPEED = float(os.environ.get("KITTEN_SPEED", "1.0"))
CUSTOM = os.environ.get("KITTEN_CUSTOM_VOICE")      # Pfad zu eigener Stimme (.npy, [510,256] float32)
CUSTOM_NAME = os.environ.get("KITTEN_CUSTOM_NAME", "Eigene")

log.info("Lade Modell %s (threads=%d) ...", MODEL_PATH, THREADS)
MODEL = KittenTTS2Tiny(MODEL_PATH, threads=THREADS)
SR = MODEL.sample_rate


def add_voice(model, npy_path, name, language="de"):
    """Eigene Stimme zur Laufzeit registrieren (interne Attribute von KittenTTS2Tiny, kittenml 0.9.8)."""
    pack = np.load(npy_path, allow_pickle=False).astype(np.float32)
    assert pack.shape == (510, 256), pack.shape
    path = model.config["languages"][language]["voices"]
    model._pack(language, model._voices[language][0]["key"])   # Voice-Datei der Sprache laden
    key = name.casefold()
    model._packs[path][key] = pack
    if not any(v["key"] == key for v in model._voices[language]):
        model._voices[language].append({"key": key, "name": name, "description": f"custom: {name}"})


if CUSTOM:
    add_voice(MODEL, CUSTOM, CUSTOM_NAME)
    log.info("Eigene Stimme '%s' geladen aus %s", CUSTOM_NAME, CUSTOM)
try:  # DE/EN-Mischtext (englische Woerter englisch), aus mit TTS_MIXPHON=0
    sys.path.append(os.environ.get("MIXPHON_DIR", os.path.dirname(os.path.abspath(__file__))))
    import mixphon
    mixphon.install(MODEL)
except Exception:
    log.exception("mixphon nicht geladen, weiter ohne")
VOICES = MODEL.available_voices.get("de", [])
MODEL.generate("Hallo.", voice=VOICE, language="de")  # aufwaermen
log.info("Bereit. Stimme=%s, sample_rate=%d", VOICE, SR)
LOCK = threading.Lock()


def synth_ogg(text, voice):
    with LOCK:
        t0 = time.time()
        audio = MODEL.generate(text, voice=voice, language="de", speed=SPEED)
        gen = time.time() - t0
    pcm = (np.clip(np.asarray(audio, np.float32), -1, 1) * 32767).astype("<i2").tobytes()
    ogg = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "ogg", "pipe:1"],
        input=pcm, capture_output=True, check=True).stdout
    dur = len(audio) / SR
    log.info("speak: chars=%d voice=%s audio=%.1fs gen=%.1fs rtf=%.2fx", len(text), voice, dur, gen, dur / gen if gen else 0)
    return ogg


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def _json(self, code, obj): self._send(code, json.dumps(obj).encode(), "application/json")
    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"status": "ok", "model": "kitten-tts-2-mini", "language": "german",
                                    "default_voice": VOICE, "sample_rate": SR, "threads": THREADS})
        if self.path.startswith("/voices"):
            return self._json(200, {"default": VOICE, "voices": VOICES})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        if not self.path.startswith("/speak"):
            return self._json(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(req.get("text", "")).strip()
            if not text:
                return self._json(400, {"error": "text fehlt"})
            voice = req.get("voice") or VOICE
            if voice.casefold() not in {v.casefold() for v in VOICES}:
                voice = VOICE  # unbekannte Stimme (z.B. alte pocket-Namen) -> Standard
            self._send(200, synth_ogg(text, voice), "audio/ogg")
        except Exception as e:
            log.exception("speak fehlgeschlagen")
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    log.info("Lausche auf %s:%d", HOST, PORT)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
