#!/usr/bin/env python3
"""Verdrahtungstest fuer mixphon ohne kittenml/espeak (Stubs). Aufruf: python3 -I test_wiring.py"""
import os
import sys
import types
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@dataclass
class G2PResult:
    text: str
    phonemes: str
    fallback: list = field(default_factory=list)
    skipped: list = field(default_factory=list)
    dropped: list = field(default_factory=list)


class FakeFallback:  # Stub fuer espeak.EspeakFallback: markiert EN-Teile
    def __init__(self, british):
        self.calls = []

    def __call__(self, tok):
        self.calls.append(tok.text)
        return f"EN<{tok.text}>ɫ", 2


fe_mod = types.ModuleType("kittenml.kittentts2_tiny.frontend")
fe_mod.G2PResult = G2PResult
fe_mod.espeak = types.SimpleNamespace(EspeakFallback=FakeFallback)
fe_mod.phonemize_v2 = types.SimpleNamespace(FOLD={"̩": ""})
for name in ("kittenml", "kittenml.kittentts2_tiny"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["kittenml.kittentts2_tiny.frontend"] = fe_mod

import mixphon  # noqa: E402


class FakeDe:
    def __call__(self, text, normalise=True):
        return G2PResult(text, f"DE<{text}>", dropped=["x"] if "x" in text else [])


class FakeFrontend:
    def __init__(self):
        self._g2p, self.vocab = {}, set("<> -.,abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")  # ohne ɫ

    def g2p(self, lang):
        return self._g2p.setdefault(lang, FakeDe())


model = types.SimpleNamespace(frontend=FakeFrontend())
assert mixphon.install(model)
g = model.frontend._g2p["de"]
de_only = "Heute regnet es in Wien, also nimm den Schirm mit."
r = g(de_only)
assert r.phonemes == f"DE<{de_only}>", r
r = g("Ich hab den Play Store fertig.")
print(r.phonemes)
assert r.phonemes.startswith("DE<Ich hab den> EN<Play Store>") and "ɫ" not in r.phonemes, r
os.environ["TTS_MIXPHON"] = "0"
m2 = types.SimpleNamespace(frontend=FakeFrontend())
assert not mixphon.install(m2) and not m2.frontend._g2p
print("wiring ok")
