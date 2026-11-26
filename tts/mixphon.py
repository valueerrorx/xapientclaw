"""Gemischte DE/EN-Phonemisierung fuer KittenTTS 2 (kittenml 0.9.8, language="de").

Problem: espeak-de liest englische Woerter deutsch ("Store" -> "Schtore").
Loesung: Sprache pro Wort bestimmen, englische Wortfolgen mit espeak en-us (misaki-Notation,
wie im Kitten-Training fuer Englisch) phonemisieren, deutsche Teile unveraendert mit dem
Original-G2P. Satz ohne englisches Wort -> Original-Aufruf 1:1 (identische Phoneme).

Einhaengen (nach dem Laden des Modells):  import mixphon; mixphon.install(MODEL)
Abschalten: Umgebung TTS_MIXPHON=0.

Wortlisten in ./lexicon/ (einmal beim install() geladen):
  en.txt / de.txt      aus Wortschatz Leipzig, erzeugt von tools/build_lexicon.py
  force_en.txt / force_de.txt   Hand-Overrides (force_de gewinnt)
"""
import logging
import os
import re

log = logging.getLogger("xapient-tts.mixphon")

LEX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lexicon")
WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")
JOIN = re.compile(r"^[\s\-]*$")  # nur Leerraum/Bindestrich zwischen zwei Woertern

# Englische espeak-Symbole ausserhalb des 120er-Vocabs -> naechstes vorhandenes.
# Das mini-Modell ist EIN Modell fuer alle Sprachen inkl. Englisch: θ ð ɹ w æ ʌ ɚ ᵊ usw.
# stehen im Vocab und werden NICHT auf Deutsch gefaltet (klaenge schlechter).
EN_MAP = {
    "ɝ": "ɜɹ",  # r-gefaerbtes betontes Schwa (bird)
    "ɫ": "l",   # dunkles l
    "ʍ": "w",   # stimmloses w (which)
    "ɬ": "l",   # stimmloser lateraler Frikativ (Fremdnamen)
}

# Stil (TTS_MIXPHON_STYLE): "de" (Default) ersetzt EN-Laute, die die deutsche Stimme nicht kann
# (misaki-Diphthonge A/O/Y, æ, ʌ, Flap-T, ᵻ -> "baahkup"), durch Laute aus dem DE-Training.
# "en" = unveraendertes en-us. I (aɪ) und W (aʊ) kennt auch das DE-Training -> bleiben.
STYLES = {
    "en": {},
    "de": {"A": "eɪ", "O": "oʊ", "Y": "ɔø", "æ": "ɛ", "ʌ": "a", "T": "t", "ᵻ": "ɪ"},
}
STYLE = STYLES.get(os.environ.get("TTS_MIXPHON_STYLE", "de").strip().lower(), STYLES["de"])

EN, DE, FORCE_EN, FORCE_DE = set(), set(), set(), set()


def _load(name):
    path = os.path.join(LEX_DIR, name)
    with open(path, encoding="utf-8") as f:
        return {ln.strip() for ln in f if ln.strip() and not ln.startswith("#")}


def load_lexicon():
    global EN, DE, FORCE_EN, FORCE_DE
    EN, DE = _load("en.txt"), _load("de.txt")
    FORCE_EN, FORCE_DE = _load("force_en.txt"), _load("force_de.txt")


def word_lang(w):
    """-> ('de'|'en', mehrdeutig). Exakte Schreibweise vor Kleinform (Main vs. main)."""
    if len(w) < 2 or w.isupper() or any(c in "äöüÄÖÜß" for c in w):
        return "de", False  # Einzelbuchstaben, Akronyme (gesprochen buchstabiert), Umlaute
    low = w.lower()
    for s in (w, low):
        if s in FORCE_DE:
            return "de", False
        if s in FORCE_EN:
            return "en", False
    if low not in EN:
        return "de", False
    if w in DE or low in DE:
        return "de", True   # in beiden Listen -> deutsch (ggf. Kontextregel)
    return "en", False


def split_runs(text):
    """text -> [(lang, teiltext)], benachbarte Woerter gleicher Sprache zusammengefasst."""
    words, prev_lang, prev_end = [], None, 0
    for m in WORD.finditer(text):
        lang, amb = word_lang(m.group())
        # "Morning Brief", "Store Listing": grossgeschriebenes Wort aus beiden Listen direkt
        # hinter einem englischen Wort (nur Leerraum/Bindestrich dazwischen) -> englisch.
        if amb and prev_lang == "en" and m.group()[0].isupper() and JOIN.match(text[prev_end:m.start()]):
            lang = "en"
        words.append((lang, m.start()))
        prev_lang, prev_end = lang, m.end()
    runs = []
    for lang, start in words:
        if runs and runs[-1][0] == lang:
            continue
        runs.append([lang, 0 if not runs else start])
    out = []
    for i, (lang, start) in enumerate(runs):
        end = runs[i + 1][1] if i + 1 < len(runs) else len(text)
        seg = text[start:end].rstrip()
        seg = seg[:-1] if seg.endswith("-") else seg  # "Play-Store-Konto": Bindestrich an der Grenze weg
        out.append((lang, seg))
    return out


class _Tok:  # EspeakFallback erwartet ein Token mit .text
    def __init__(self, text):
        self.text = text


class MixG2P:
    """Ersetzt den deutschen LangG2P des Frontends; gleiche Aufrufsignatur."""

    def __init__(self, de_g2p, vocab):
        from kittenml.kittentts2_tiny.frontend import G2PResult, espeak, phonemize_v2
        self.de, self.vocab, self.fold, self.result = de_g2p, vocab, phonemize_v2.FOLD, G2PResult
        self.en = espeak.EspeakFallback(british=False)  # en-us, misaki-Notation (wie Training)

    def _en(self, seg):
        ps, _ = self.en(_Tok(seg))
        ps = (ps or "").strip()
        for table in (self.fold, EN_MAP, STYLE):
            for src, dst in table.items():
                if src in ps:
                    ps = ps.replace(src, dst)
        return "".join(c for c in ps if c in self.vocab)

    def __call__(self, text, normalise=True):
        runs = split_runs(text)
        if all(lang == "de" for lang, _ in runs):
            return self.de(text, normalise)  # rein deutsch: Original-Pfad, identisch
        parts, dropped = [], set()
        for lang, seg in runs:
            if lang == "en":
                parts.append(self._en(seg))
            else:
                r = self.de(seg, normalise)
                parts.append(r.phonemes)
                dropped.update(r.dropped)
        return self.result(text, " ".join(p for p in parts if p), [], [], sorted(dropped))


def install(model, language="de"):
    """Haengt MixG2P in model.frontend ein. -> True wenn aktiv."""
    if os.environ.get("TTS_MIXPHON", "1").strip().lower() in ("0", "false", "off", "aus"):
        log.info("mixphon: aus (TTS_MIXPHON)")
        return False
    load_lexicon()
    fe = model.frontend
    de_g2p = fe.g2p(language)
    if not isinstance(de_g2p, MixG2P):
        fe._g2p[language] = MixG2P(de_g2p, fe.vocab)
    log.info("mixphon: an (en=%d de=%d force_en=%d force_de=%d)", len(EN), len(DE), len(FORCE_EN), len(FORCE_DE))
    return True
